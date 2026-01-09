export const getMainTs = (title) => {
    const safeTitle = title.replace(/'/g, "\\'");
    return `
import express from 'express';
import { 
    createServer, 
    context, 
    getServerPort, 
    redis, 
    reddit,
    realtime
} from '@devvit/web/server';

const app = express();

// Body parsers
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.text({ limit: '10mb' }));

const router = express.Router();

// --- Database Helpers ---
const DB_REGISTRY_KEY = 'sys:registry';

async function fetchAllData() {
    try {
        const collections = await redis.zRange(DB_REGISTRY_KEY, 0, -1);
        const dbData = {};

        await Promise.all(collections.map(async (item) => {
            const colName = typeof item === 'string' ? item : item.member;
            const raw = await redis.hGetAll(colName);
            const parsed = {};
            for (const [k, v] of Object.entries(raw)) {
                try { parsed[k] = JSON.parse(v); } catch(e) { parsed[k] = v; }
            }
            dbData[colName] = parsed;
        }));

        let user = { 
            id: 'anon', 
            username: 'Guest', 
            avatar_url: 'https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png' 
        };
        
        try {
            // Try to get current user from context or Reddit API
            if (context.userId) {
                user = { 
                    id: context.userId, 
                    username: context.username || 'RedditUser',
                    avatar_url: user.avatar_url // Default
                };
            }
            
            // Always try to fetch rich profile for snoovatar (Server Source of Truth)
            const currUser = await reddit.getCurrentUser();
            if (currUser) {
                const snoovatarUrl = await currUser.getSnoovatarUrl();
                user = {
                    id: currUser.id,
                    username: currUser.username,
                    // Use Snoovatar if available, else fallback to standard Reddit static default
                    avatar_url: snoovatarUrl ?? 'https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png'
                };
            }
        } catch(e) { 
            console.warn('User fetch failed', e); 
        }

        return { dbData, user };
    } catch(e) {
        console.error('Hydration Error:', e);
        return { dbData: {}, user: null };
    }
}

// --- API Routes (Client -> Server) ---
// Note: All client-callable endpoints must start with /api/

// --- Realtime & Multiplayer Endpoints ---

const ROOM_CHANNEL = 'room_default';
const KEY_ROOM_STATE = 'room:state';
const KEY_PRESENCE = 'room:presence';

// Helper: Get full presence map
async function getPresenceMap() {
    const raw = await redis.hGetAll(KEY_PRESENCE);
    const presence = {};
    const now = Date.now();
    const TIMEOUT = 30000; // 30s timeout for presence
    const toDelete = [];

    for (const [id, val] of Object.entries(raw)) {
        try {
            const parsed = JSON.parse(val);
            if (now - parsed._lastSeen > TIMEOUT) {
                toDelete.push(id);
            } else {
                presence[id] = parsed;
            }
        } catch(e) {}
    }

    if (toDelete.length > 0) {
        await redis.hDel(KEY_PRESENCE, toDelete);
    }
    return presence;
}

router.get('/api/realtime/init', async (_req, res) => {
    try {
        const { user } = await fetchAllData();
        const roomStateStr = await redis.get(KEY_ROOM_STATE);
        const roomState = roomStateStr ? JSON.parse(roomStateStr) : {};
        const presence = await getPresenceMap();

        res.json({
            clientId: user.id,
            user: user,
            roomState,
            presence,
            channel: ROOM_CHANNEL
        });
    } catch(e) {
        console.error('Realtime Init Error:', e);
        res.status(500).json({ error: e.message });
    }
});

router.post('/api/realtime/update-room', async (req, res) => {
    try {
        const { update } = req.body;
        // Merge state (shallow merge of top-level keys for simplicity, or deep if needed)
        // WebSim implies object merging.
        const currentStr = await redis.get(KEY_ROOM_STATE);
        let current = currentStr ? JSON.parse(currentStr) : {};
        
        // Apply updates (handling nulls to delete)
        for (const [k, v] of Object.entries(update)) {
            if (v === null) delete current[k];
            else current[k] = v;
        }

        await redis.set(KEY_ROOM_STATE, JSON.stringify(current));
        
        // Broadcast
        await realtime.send(ROOM_CHANNEL, {
            type: 'roomState',
            payload: update // Send partial update to clients
        });
        
        res.json({ success: true });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/api/realtime/update-presence', async (req, res) => {
    try {
        const { update, user } = req.body;
        if (!user || !user.id) return res.status(401).json({ error: 'No user' });

        const presenceKey = user.id;
        
        // Get current presence for this user
        const currentStr = await redis.hGet(KEY_PRESENCE, presenceKey);
        let current = currentStr ? JSON.parse(currentStr) : {};
        
        // Merge
        const newState = { 
            ...current, 
            ...update, 
            username: user.username,
            avatarUrl: user.avatar_url,
            _lastSeen: Date.now()
        };

        await redis.hSet(KEY_PRESENCE, { [presenceKey]: JSON.stringify(newState) });

        // Broadcast
        await realtime.send(ROOM_CHANNEL, {
            type: 'presence',
            clientId: presenceKey,
            payload: newState
        });

        res.json({ success: true });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/api/realtime/event', async (req, res) => {
    try {
        const { event, clientId } = req.body;
        await realtime.send(ROOM_CHANNEL, {
            type: 'event',
            fromClientId: clientId,
            payload: event
        });
        res.json({ success: true });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/api/realtime/request-update', async (req, res) => {
    try {
        const { targetClientId, update, fromClientId } = req.body;
        await realtime.send(ROOM_CHANNEL, {
            type: 'requestUpdate',
            targetClientId,
            fromClientId,
            payload: update
        });
        res.json({ success: true });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

router.get('/api/init', async (_req, res) => {
    const data = await fetchAllData();
    res.json(data);
});

router.get('/api/user', async (_req, res) => {
    const { user } = await fetchAllData();
    res.json(user);
});

router.get('/api/identity', async (_req, res) => {
    const { user } = await fetchAllData();
    res.json(user);
});

router.post('/api/save', async (req, res) => {
    try {
        const { collection, key, value } = req.body;
        await redis.hSet(collection, { [key]: JSON.stringify(value) });
        await redis.zAdd(DB_REGISTRY_KEY, { member: collection, score: Date.now() });
        res.json({ success: true, collection, key });
    } catch(e) {
        console.error('DB Save Error:', e);
        res.status(500).json({ error: e.message });
    }
});

router.post('/api/load', async (req, res) => {
    try {
        const { collection, key } = req.body;
        const value = await redis.hGet(collection, key);
        res.json({ collection, key, value: value ? JSON.parse(value) : null });
    } catch(e) {
        console.error('DB Get Error:', e);
        res.status(500).json({ error: e.message });
    }
});

router.post('/api/delete', async (req, res) => {
    try {
        const { collection, key } = req.body;
        await redis.hDel(collection, [key]);
        res.json({ success: true, collection, key });
    } catch(e) {
        console.error('DB Delete Error:', e);
        res.status(500).json({ error: e.message });
    }
});

// --- Avatar Lookup Route (Client Injection) ---
router.get('/api/lookup/avatar/:username', async (req, res) => {
    const { username } = req.params;
    try {
        const user = await reddit.getUserByUsername(username);
        let url = null;
        if (user) {
            url = await user.getSnoovatarUrl();
        }
        res.json({ url: url || 'https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png' });
    } catch (e) {
        res.json({ url: 'https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png' });
    }
});

// --- WebSim Search Proxies ---
router.get('/api/v1/search/assets', async (req, res) => {
    try {
        const query = new URLSearchParams(req.query).toString();
        const response = await fetch(\`https://websim.ai/api/v1/search/assets?\${query}\`);
        if (!response.ok) return res.status(response.status).json({ error: 'Upstream Error' });
        const data = await response.json();
        res.json(data);
    } catch (e) {
        console.error('Search Proxy Error:', e);
        res.status(500).json({ error: e.message });
    }
});

router.get('/api/v1/search/assets/relevant', async (req, res) => {
    try {
        const query = new URLSearchParams(req.query).toString();
        const response = await fetch(\`https://websim.ai/api/v1/search/assets/relevant?\${query}\`);
        if (!response.ok) return res.status(response.status).json({ error: 'Upstream Error' });
        const data = await response.json();
        res.json(data);
    } catch (e) {
        console.error('Search Proxy Error:', e);
        res.status(500).json({ error: e.message });
    }
});

// --- Avatar Proxy Route (Legacy/Fallback) ---
router.get('/api/proxy/avatar/:username', async (req, res) => {
    const { username } = req.params;
    try {
        // Attempt to get the latest Snoovatar from Reddit
        const user = await reddit.getUserByUsername(username);
        let url = null;
        if (user) {
            url = await user.getSnoovatarUrl();
        }
        res.redirect(url || 'https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png');
    } catch (e) {
        // Fallback silently if user not found or API error
        res.redirect('https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png');
    }
});

// --- JSON "File" Upload Routes (Redis-backed) ---
router.post('/api/json/:key', async (req, res) => {
    try {
        const { key } = req.params;
        const data = req.body;
        // Persist JSON to Redis
        await redis.set('json:' + key, JSON.stringify(data));
        res.json({ ok: true, url: '/api/json/' + key });
    } catch(e) {
        console.error('JSON Upload Error:', e);
        res.status(500).json({ error: e.message });
    }
});

router.get('/api/json/:key', async (req, res) => {
    try {
        const { key } = req.params;
        const data = await redis.get('json:' + key);
        if (!data) return res.status(404).json({ error: 'Not found' });
        
        // Return as proper JSON
        res.header('Content-Type', 'application/json');
        res.send(data);
    } catch(e) {
        console.error('JSON Load Error:', e);
        res.status(500).json({ error: e.message });
    }
});

// --- Internal Routes (Menu/Triggers) ---
// Note: All internal endpoints must start with /internal/

router.post('/internal/onInstall', async (req, res) => {
    console.log('App installed!');
    res.json({ success: true });
});

router.post('/internal/createPost', async (req, res) => {
    console.log('Creating game post...');
    
    try {
        // Use the global context object from @devvit/web/server, fallback to headers if needed
        const subredditName = context?.subredditName || req.headers['x-devvit-subreddit-name'];
        console.log('Context Subreddit:', subredditName);

        if (!subredditName) {
            return res.status(400).json({ error: 'Subreddit name is required (context/header missing)' });
        }

        const post = await reddit.submitCustomPost({
            title: '${safeTitle}',
            subredditName: subredditName,
            entry: 'default', // matches devvit.json entrypoint
            userGeneratedContent: {
                text: 'Play this game built with WebSim!'
            }
        });

        res.json({
            showToast: { text: 'Game post created!' },
            navigateTo: post
        });
    } catch (e) {
        console.error('Failed to create post:', e);
        res.status(500).json({ error: e.message });
    }
});

app.use(router);

const port = getServerPort();
const server = createServer(app);

server.on('error', (err) => console.error(\`server error; \${err.stack}\`));
server.listen(port, () => console.log(\`Server listening on \${port}\`));
`;
};

