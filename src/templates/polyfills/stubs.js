export const websimStubsJs = `
// [WebSim] API Stubs - Global Script
(function() {
    let _currentUser = null;

    // Listen for identity update from Socket Handshake or direct message
    const updateIdentity = (user) => {
        _currentUser = user;
        if (window.WebsimSocket && window.WebsimSocket.updateIdentity) {
            window.WebsimSocket.updateIdentity(user);
        }
    };

    // Also listen to window messages for 'set_user_context' just in case
    window.addEventListener('message', (e) => {
        let data = e.data;
        if (typeof data === 'string') { try { data = JSON.parse(data); } catch(e) {} }
        if (data && (data.type === 'set_user_context' || (data.payload && data.payload.user))) {
            const user = data.payload.user || data.payload;
            updateIdentity(user);
        }
    });

    if (!window.websim) {
        window.websim = {
            getCurrentUser: async () => {
                // Wait for handshake
                let tries = 0;
                while(!_currentUser && tries < 20) {
                    await new Promise(r => setTimeout(r, 100));
                    tries++;
                }
                return _currentUser || {
                    id: 'guest', username: 'Guest', avatar_url: 'https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png'
                };
            },
            getProject: async () => ({ id: 'local', title: 'Reddit Game' }),
            collection: (name) => {
                // Return safe stubs to prevent crashes before hydration
                return window.websimSocketInstance ? window.websimSocketInstance.collection(name) : {
                    subscribe: () => {}, 
                    getList: () => [], 
                    create: async () => {}, 
                    update: async () => {}, 
                    delete: async () => {}, 
                    filter: () => ({ subscribe: () => {}, getList: () => [] })
                };
            },
            search: {
                assets: async (opts) => {
                    const params = new URLSearchParams();
                    if (opts.q) params.set('q', opts.q);
                    if (opts.mime_type_prefix) params.set('mime_type_prefix', opts.mime_type_prefix);
                    if (opts.limit) params.set('limit', opts.limit);
                    return fetch('/api/v1/search/assets?' + params.toString()).then(r => r.json());
                },
                relevant: async (opts) => {
                    const params = new URLSearchParams();
                    if (opts.q) params.set('q', opts.q);
                    if (opts.limit) params.set('limit', opts.limit);
                    return fetch('/api/v1/search/assets/relevant?' + params.toString()).then(r => r.json());
                }
            },
            upload: async (file) => {
                // Smart Upload: JSON persistence via Redis, Media via BlobURL (session)
                try {
                    let isJson = file.type === 'application/json' || (file.name && file.name.endsWith('.json'));
                    
                    if (!isJson && (!file.type || file.type === 'text/plain')) {
                        try {
                            // Quick sniff for JSON content
                            const text = await file.text();
                            const trimmed = text.trim();
                            if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
                                JSON.parse(trimmed);
                                isJson = true;
                            }
                        } catch(e) {}
                    }

                    if (isJson) {
                        const text = await file.text();
                        const data = JSON.parse(text);
                        // Generate ID
                        const key = 'up_' + Math.random().toString(36).substr(2, 9);
                        
                        // Upload to our custom JSON route
                        await fetch('/api/json/' + key, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(data)
                        });
                        
                        return '/api/json/' + key;
                    }
                    
                    // Fallback to Blob URL for images/audio (Session only)
                    return URL.createObjectURL(file);
                } catch(e) { 
                    console.error("Upload failed", e);
                    return ''; 
                }
            }
        };
    }
})();
`;