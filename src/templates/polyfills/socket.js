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

    // Mock WebSimSocket Class
    window.WebsimSocket = class WebsimSocket {
        constructor() {
            if (!window.websimSocketInstance) {
                window.websimSocketInstance = { 
                    collection: (name) => new AdapterCollection(name),
                    // Defensive: Add common methods that might be expected
                    initialize: () => { console.log("[WebSim] Socket initialized (stub)"); return Promise.resolve(); },
                    connect: () => { console.log("[WebSim] Socket connected (stub)"); return Promise.resolve(); },
                };
            }
            return window.websimSocketInstance;
        }
        static updateIdentity(user) {
            window._currentUser = user;
        }
    };
    
    // Auto-instantiate if game expects 'party'
    if (!window.party) { 
        window.websimSocketInstance = { 
            collection: (name) => new AdapterCollection(name),
            initialize: () => { console.log("[WebSim] Party initialized (stub)"); return Promise.resolve(); },
            connect: () => { console.log("[WebSim] Party connected (stub)"); return Promise.resolve(); },
        };
        window.party = window.websimSocketInstance; 
    }
})();
`;