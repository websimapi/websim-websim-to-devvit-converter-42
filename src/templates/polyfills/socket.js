export const websimSocketPolyfill = `
// [WebSim] Realtime Multiplayer Polyfill (Devvit Adapter)
(function() {
    window.WebsimSocket = class WebsimSocket {
        constructor() {
            this.presence = {};
            this.roomState = {};
            this.peers = {}; // Peers map: clientId -> UserData
            this.clientId = null;
            this.ws = null; // Realtime connection reference
            
            this.subscriptions = {
                presence: new Set(),
                roomState: new Set(),
                presenceRequests: new Set()
            };
            
            this.onmessage = null; // Client can overwrite
        }

        // WebSim API: Mock collection for non-realtime persistence if needed
        collection(name) {
             return {
                 subscribe: () => {},
                 getList: () => [],
                 create: async () => {},
                 update: async () => {},
                 delete: async () => {},
                 filter: () => ({ subscribe: () => {}, getList: () => [] })
             };
        }

        async initialize() {
            console.log("[WebSim] Initializing Realtime Socket...");
            
            // 1. Identity
            const user = await window.websim.getCurrentUser();
            this.clientId = user.id;

            // 2. Initial State Fetch (HTTP) - Hydrate before connecting
            try {
                const res = await fetch('/api/realtime/init');
                if (res.ok) {
                    const data = await res.json();
                    this.presence = data.presence || {};
                    this.roomState = data.roomState || {};
                    this._updatePeersFromPresence();
                }
            } catch(e) {
                console.error("[WebSim] Failed to fetch initial state", e);
            }

            // 3. Connect Realtime
            try {
                // Dynamic import of Devvit Client SDK
                const { connectRealtime } = await import('@devvit/web/client');
                
                this.ws = await connectRealtime({
                    channel: 'default', // Single global channel for now
                    onMessage: (msg) => this._handleMessage(msg),
                    onConnect: () => console.log("[WebSim] Realtime Connected"),
                    onDisconnect: () => console.log("[WebSim] Realtime Disconnected")
                });
                
                // 4. Announce Self
                this.updatePresence({ joined: true });
                
            } catch(e) {
                console.error("[WebSim] Realtime connection failed", e);
                if (e.name === 'ReferenceError' && e.message.includes('require')) {
                    console.error("[WebSim] This error is usually caused by a dependency using CommonJS 'require' which is not supported in the browser. Check vite.config.ts commonjsOptions.");
                }
            }
        }

        _handleMessage(msg) {
            // Message format: { type, clientId?, data?, event?, ... }
            
            if (msg.type === 'presence') {
                const { clientId, data } = msg;
                if (!clientId) return;
                
                // data === null implies disconnect/leave (if we implemented leave logic)
                if (data === null) {
                    delete this.presence[clientId];
                } else {
                    this.presence[clientId] = data;
                }
                
                this._updatePeersFromPresence();
                this._notify(this.subscriptions.presence, this.presence);
                
            } else if (msg.type === 'roomState') {
                const { data } = msg;
                // Merge Room State
                this.roomState = { ...this.roomState, ...data };
                Object.keys(data).forEach(k => {
                    if (data[k] === null) delete this.roomState[k];
                });
                
                this._notify(this.subscriptions.roomState, this.roomState);
                
            } else if (msg.type === 'event') {
                const { event, from } = msg;
                if (this.onmessage) {
                     this.onmessage({ data: { ...event, clientId: from } });
                }
                
            } else if (msg.type === 'presenceRequest') {
                const { targetId, update, from } = msg;
                if (targetId === this.clientId) {
                    this._notify(this.subscriptions.presenceRequests, update, from);
                }
            }
        }

        _updatePeersFromPresence() {
            // Rebuild peers map based on valid presence data
            this.peers = {};
            Object.entries(this.presence).forEach(([id, p]) => {
                if (p._user) {
                    this.peers[id] = p._user;
                }
            });
            
            // Ensure self is in peers (Devvit might be slow to echo back our own presence)
            if (this.clientId && !this.peers[this.clientId]) {
                window.websim.getCurrentUser().then(u => {
                     this.peers[this.clientId] = u;
                });
            }
        }

        _notify(set, ...args) {
            set.forEach(cb => {
                try { cb(...args); } catch(e) { console.error(e); }
            });
        }

        // --- Public API ---
        
        async updatePresence(data) {
            const user = await window.websim.getCurrentUser();
            // Optimistic Update
            this.presence[this.clientId] = { ...this.presence[this.clientId], ...data, _user: user };
            this._updatePeersFromPresence();
            this._notify(this.subscriptions.presence, this.presence);

            const payload = { clientId: this.clientId, user, data };
            
            fetch('/api/realtime/update-presence', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            }).catch(e => console.error("Presence sync failed", e));
        }

        updateRoomState(data) {
            // Optimistic Update
            this.roomState = { ...this.roomState, ...data };
            Object.keys(data).forEach(k => {
                if (data[k] === null) delete this.roomState[k];
            });
            this._notify(this.subscriptions.roomState, this.roomState);

            fetch('/api/realtime/update-room-state', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ data })
            }).catch(e => console.error("RoomState sync failed", e));
        }

        send(event) {
            fetch('/api/realtime/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ event, clientId: this.clientId })
            }).catch(e => console.error("Event send failed", e));
        }

        requestPresenceUpdate(targetId, update) {
            fetch('/api/realtime/request-update', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ targetId, update, from: this.clientId })
            }).catch(e => console.error("Presence request failed", e));
        }

        // Subscriptions
        subscribePresence(cb) {
            this.subscriptions.presence.add(cb);
            cb(this.presence);
            return () => this.subscriptions.presence.delete(cb);
        }

        subscribeRoomState(cb) {
            this.subscriptions.roomState.add(cb);
            cb(this.roomState);
            return () => this.subscriptions.roomState.delete(cb);
        }

        subscribePresenceUpdateRequests(cb) {
            this.subscriptions.presenceRequests.add(cb);
            return () => this.subscriptions.presenceRequests.delete(cb);
        }
    };
    
    // Auto-instantiate singleton for legacy/compatibility
    // This prevents 'peers undefined' crashes if app assumes 'party' or 'room' exists globally
    // We instantiate it but let the app call initialize() usually.
    if (!window.party) {
        window.party = new window.WebsimSocket();
    }
    
    // Some apps might look for window.websimSocketInstance
    window.websimSocketInstance = window.party;

})();
`;