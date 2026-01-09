export const websimSocketPolyfill = `
// [WebSim] Generic DB & Bridge Polyfill
(function() {
    // ------------------------------------------------------------------------
    // 1. Generic Bridge (Devvit <-> Webview)
    // ------------------------------------------------------------------------
    window._genericDB = {};
    window._listCache = {}; // Cache for stable array references
    window._subscribers = {};
    window._currentUser = null;

    const DevvitBridge = {
        init: async () => {
            console.log("[Bridge] Initializing...");
            
            try {
                // Load initial data from server via HTTP
                const data = await fetch('/api/init').then(r => r.json());
                
                if (data.dbData) {
                    window._genericDB = data.dbData;
                    window._listCache = {}; // Reset cache
                    
                    // Hot-swap identity: Use Reddit identity from server
                    window._currentUser = data.user;
                    console.log("[Bridge] Identity Swapped:", window._currentUser);
                    
                    // Legacy stub support
                    if (window.WebsimSocket && window.WebsimSocket.updateIdentity && data.user) {
                        window.WebsimSocket.updateIdentity(data.user);
                    }
                    
                    const readyEvent = new CustomEvent('GAMEDATA_READY', { 
                        detail: data.dbData 
                    });
                    window.dispatchEvent(readyEvent);
                    
                    Object.keys(window._subscribers).forEach(col => {
                        DevvitBridge.notifySubscribers(col);
                    });
                }
            } catch (e) {
                console.warn("[Bridge] Init failed (might be offline)", e);
            }
        },

        getListSnapshot: (collection) => {
            if (!window._listCache[collection]) {
                const list = Object.values(window._genericDB[collection] || {});
                list.sort((a,b) => (b.created_at || 0) < (a.created_at || 0) ? -1 : 1);
                window._listCache[collection] = list;
            }
            return window._listCache[collection];
        },

        notifySubscribers: (collection) => {
            // Invalidate cache
            delete window._listCache[collection];
            const list = DevvitBridge.getListSnapshot(collection);
            
            if (window._subscribers[collection]) {
                window._subscribers[collection].forEach(cb => {
                    try { cb(list); } catch(e) { console.error(e); }
                });
            }
        }
    };

    // Expose API
    window.GenericDB = {
        save: async (collection, key, value) => {
            if (!window._genericDB[collection]) {
                window._genericDB[collection] = {};
            }
            window._genericDB[collection][key] = value;
            
            // Optimistic local update
            DevvitBridge.notifySubscribers(collection);
            
            // Send to server via HTTP
            try {
                await fetch('/api/save', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ collection, key, value })
                });
            } catch (e) {
                console.error("[Bridge] Save failed:", e);
            }
        },
        
        get: (collection, key) => {
            return window._genericDB[collection]?.[key] || null;
        },
        
        getAll: (collection) => {
            return window._genericDB[collection] || {};
        },

        getList: (collection) => {
            return DevvitBridge.getListSnapshot(collection);
        },
        
        // Async get from server (bypasses cache)
        fetchFromServer: async (collection, key) => {
            try {
                const res = await fetch('/api/load', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ collection, key })
                });
                const data = await res.json();
                return data.value;
            } catch(e) { 
                console.error("[Bridge] Load failed:", e);
                return null; 
            }
        },
        
        delete: async (collection, key) => {
            if (window._genericDB[collection]) {
                delete window._genericDB[collection][key];
            }
            DevvitBridge.notifySubscribers(collection);
            
            try {
                await fetch('/api/delete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ collection, key })
                });
            } catch (e) {
                console.error("[Bridge] Delete failed:", e);
            }
        },
        
        subscribe: (collection, callback) => {
            if (!window._subscribers[collection]) {
                window._subscribers[collection] = [];
            }
            window._subscribers[collection].push(callback);
            
            // Immediate callback with current data
            // Use cached snapshot to prevent React infinite loops
            const currentList = DevvitBridge.getListSnapshot(collection);
            try { callback(currentList); } catch(e) {}
            
            // Return unsubscribe function
            return () => {
                window._subscribers[collection] = 
                    window._subscribers[collection].filter(f => f !== callback);
            };
        }
    };

    // Initialize on load
    if (document.readyState === 'complete') {
        setTimeout(DevvitBridge.init, 100);
    } else {
        window.addEventListener('load', () => setTimeout(DevvitBridge.init, 100));
    }

    // ------------------------------------------------------------------------
    // 2. WebSim Adapter (Backward Compatibility)
    // ------------------------------------------------------------------------
    class AdapterCollection {
        constructor(name) { this.name = name; }
        
        getList = () => { 
            return window.GenericDB.getList(this.name);
        }
        
        create = async (data) => {
            const id = Math.random().toString(36).substr(2, 12);
            
            // Enforce Reddit Identity on content creation
            const enhancedData = { ...data };
            if (window._currentUser) {
                enhancedData.username = window._currentUser.username;
                enhancedData.avatar_url = window._currentUser.avatar_url;
                enhancedData.user_id = window._currentUser.id;
            }

            const record = { 
                id, 
                ...enhancedData, 
                created_at: new Date().toISOString() 
            };
            window.GenericDB.save(this.name, id, record);
            return record;
        }

        update = async (id, data) => {
            const current = window.GenericDB.get(this.name, id);
            // If not found in cache, we could optionally await fetchFromServer here, 
            // but strict WebSim API is synchronous for getList/etc usually, async for update.
            // For now, assume hydration is complete or we rely on cache.
            if (!current) throw new Error('Record not found or not loaded');
            
            const record = { ...current, ...data };
            window.GenericDB.save(this.name, id, record);
            return record;
        }

        delete = async (id) => {
             await window.GenericDB.delete(this.name, id);
        }

        subscribe = (cb) => {
            return window.GenericDB.subscribe(this.name, cb);
        }
        
        filter(criteria) {
             const self = this;
             return {
                 getList: () => self.getList().filter(r => self._matches(r, criteria)),
                 subscribe: (cb) => {
                     const wrapped = (list) => cb(list.filter(r => self._matches(r, criteria)));
                     return self.subscribe(wrapped);
                 }
             };
        }
        _matches(record, criteria) {
            for (let key in criteria) { if (record[key] !== criteria[key]) return false; }
            return true;
        }
    }

    // ------------------------------------------------------------------------
    // 3. WebSim Realtime Adapter (Devvit Migration)
    // ------------------------------------------------------------------------
    
    class DevvitRealtimeAdapter {
        constructor() {
            this.roomState = {};
            this.presence = {};
            this.peers = {};
            this.clientId = null;
            this.onmessage = null; // User assigns this
            this.connected = false;
            
            this._subs = {
                presence: new Set(),
                roomState: new Set(),
                requests: new Set()
            };
            
            // Queue updates to prevent flooding (throttle)
            this._updateQueue = {
                presence: null,
                room: {}
            };
            this._throttleTimer = null;
        }

        async initialize() {
            console.log("[WebSim] Initializing Realtime Adapter...");
            
            // 1. Fetch Identity & Initial State
            try {
                const res = await fetch('/api/realtime/init');
                if (!res.ok) throw new Error('Init failed');
                const data = await res.json();
                
                this.clientId = data.clientId;
                this.roomState = data.roomState;
                this.presence = data.presence;
                this._currentUser = data.user;
                
                // Construct peers list from presence
                this._updatePeers();
                
                console.log(\`[WebSim] Connected as \${this.clientId} (\${this._currentUser.username})\`);
                
                // 2. Connect to Devvit Realtime
                // Dynamic import to avoid build-time issues with concatenator
                const { connectRealtime } = await import('@devvit/web/client');
                
                this.socket = connectRealtime({
                    channel: data.channel || 'room_default',
                    onMessage: (msg) => this._handleMessage(msg)
                });
                
                // Safety check for socket interface and subscription
                if (this.socket && typeof this.socket.subscribe === 'function') {
                    this.socket.subscribe();
                }
                this.connected = true;

                // Start Throttle Loop (100ms)
                setInterval(() => this._flushUpdates(), 100);

            } catch (e) {
                console.error("[WebSim] Realtime init error:", e);
                // Fallback for offline testing
                this.clientId = 'offline-' + Math.random().toString(36).slice(2,6);
                this.presence[this.clientId] = { 
                    username: 'OfflineUser', 
                    avatarUrl: 'https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png'
                };
                this._updatePeers();
            }
        }

        // --- Public API ---

        subscribePresence(cb) {
            this._subs.presence.add(cb);
            // Immediate callback
            try { cb(this.presence); } catch(e) {}
            return () => this._subs.presence.delete(cb);
        }

        subscribeRoomState(cb) {
            this._subs.roomState.add(cb);
            try { cb(this.roomState); } catch(e) {}
            return () => this._subs.roomState.delete(cb);
        }

        subscribePresenceUpdateRequests(cb) {
            this._subs.requests.add(cb);
            return () => this._subs.requests.delete(cb);
        }

        updatePresence(update) {
            // Optimistic update
            const myState = this.presence[this.clientId] || {};
            const newState = { ...myState, ...update };
            this.presence[this.clientId] = newState;
            this._updatePeers();
            
            // Notify local subscribers
            this._notifyPresence();
            
            // Queue for network
            this._updateQueue.presence = { ...this._updateQueue.presence, ...update };
        }

        updateRoomState(update) {
            // Optimistic update
            // Handle nulls for deletion
            for (const [k, v] of Object.entries(update)) {
                if (v === null) delete this.roomState[k];
                else this.roomState[k] = v;
            }
            
            this._notifyRoomState();
            
            // Queue for network
            // Note: Simplistic merging for queue. 
            // If user sets A=1 then A=2 quickly, we send A=2. 
            // If user sets A=1 then A=null, we send A=null.
            for (const [k, v] of Object.entries(update)) {
                this._updateQueue.room[k] = v;
            }
        }

        requestPresenceUpdate(targetClientId, update) {
            // Send immediately (no throttle for events/RPC)
            fetch('/api/realtime/request-update', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    targetClientId,
                    update,
                    fromClientId: this.clientId
                })
            }).catch(e => console.error("RPC Error:", e));
        }

        send(event) {
            // Ephemeral event
            fetch('/api/realtime/event', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    event: event,
                    clientId: this.clientId
                })
            }).catch(e => console.error("Event Error:", e));
        }
        
        // Backward compatibility for generic collections
        collection(name) {
            return new AdapterCollection(name);
        }

        // --- Internal ---

        _updatePeers() {
            this.peers = {};
            for (const [id, p] of Object.entries(this.presence)) {
                this.peers[id] = {
                    id: id,
                    username: p.username || 'Anonymous',
                    avatarUrl: p.avatarUrl || p.avatar_url
                };
            }
        }

        _notifyPresence() {
            for (const cb of this._subs.presence) {
                try { cb(this.presence); } catch(e) { console.error(e); }
            }
        }

        _notifyRoomState() {
            for (const cb of this._subs.roomState) {
                try { cb(this.roomState); } catch(e) { console.error(e); }
            }
        }

        _handleMessage(msg) {
            // msg format depends on server payload
            // Our server sends { type, payload, ... }
            // But Devvit wrapper might wrap it. 
            // Assuming msg is the payload sent from server.
            
            // Check if msg is nested in an event object or direct
            const data = msg; 

            if (!data || !data.type) return;

            switch(data.type) {
                case 'roomState':
                    // Partial update from others
                    const update = data.payload;
                    for (const [k, v] of Object.entries(update)) {
                        if (v === null) delete this.roomState[k];
                        else this.roomState[k] = v;
                    }
                    this._notifyRoomState();
                    break;

                case 'presence':
                    const pid = data.clientId;
                    if (pid === this.clientId) return; // Ignore echo if any
                    this.presence[pid] = data.payload;
                    this._updatePeers();
                    this._notifyPresence();
                    break;

                case 'event':
                    // Dispatch to onmessage
                    if (this.onmessage) {
                        // WebSim format: { data: { ...payload, clientId, username } }
                        const evt = {
                            data: {
                                ...data.payload,
                                clientId: data.fromClientId
                            }
                        };
                        try { this.onmessage(evt); } catch(e) { console.error(e); }
                    }
                    break;
                
                case 'requestUpdate':
                    if (data.targetClientId === this.clientId) {
                        for (const cb of this._subs.requests) {
                            try { cb(data.payload, data.fromClientId); } catch(e) {}
                        }
                    }
                    break;
            }
        }

        async _flushUpdates() {
            // Flush Presence
            if (this._updateQueue.presence) {
                const payload = this._updateQueue.presence;
                this._updateQueue.presence = null;
                
                try {
                    await fetch('/api/realtime/update-presence', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            update: payload,
                            user: this._currentUser
                        })
                    });
                } catch(e) { console.warn("Presence sync fail", e); }
            }

            // Flush Room State
            if (Object.keys(this._updateQueue.room).length > 0) {
                const payload = this._updateQueue.room;
                this._updateQueue.room = {}; // Reset

                try {
                    await fetch('/api/realtime/update-room', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ update: payload })
                    });
                } catch(e) { console.warn("Room sync fail", e); }
            }
        }
    }

    // Singleton Instance
    window.websimSocketInstance = new DevvitRealtimeAdapter();
    window.WebsimSocket = class WebsimSocket {
        constructor() { return window.websimSocketInstance; }
    };
    window.party = window.websimSocketInstance;

})();
`;