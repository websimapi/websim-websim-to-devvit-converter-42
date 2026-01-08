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

// --- Realtime / Multiplayer Routes ---
router.get('/api/realtime/init', async (_req, res) => {
    try {
        const presence = await redis.hGetAll('room:default:presence');
        const roomState = await redis.hGetAll('room:default:state');
        
        // Parse JSON values
        const parsedPresence = {};
        for (const [k, v] of Object.entries(presence)) parsedPresence[k] = JSON.parse(v);
        
        const parsedState = {};
        for (const [k, v] of Object.entries(roomState)) parsedState[k] = JSON.parse(v);

        res.json({ presence: parsedPresence, roomState: parsedState });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/api/realtime/update-presence', async (req, res) => {
    const { clientId, data, user } = req.body;
    if (!clientId) return res.status(400).json({error: 'Missing clientId'});

    // Save to Redis (with user info for peers list)
    const presenceData = { ...data, _user: user, _lastSeen: Date.now() };
    await redis.hSet('room:default:presence', { [clientId]: JSON.stringify(presenceData) });
    
    // Broadcast
    await realtime.send('default', {
        type: 'presence',
        clientId,
        data: presenceData
    });
    
    res.json({ ok: true });
});

router.post('/api/realtime/update-room-state', async (req, res) => {
    const { data } = req.body;
    
    // Merge/Save to Redis
    const updates = {};
    for (const [k, v] of Object.entries(data)) {
        updates[k] = JSON.stringify(v);
    }
    await redis.hSet('room:default:state', updates);

    // Broadcast partial update
    await realtime.send('default', {
        type: 'roomState',
        data
    });
    
    res.json({ ok: true });
});

router.post('/api/realtime/send', async (req, res) => {
    const { event, clientId } = req.body;
    await realtime.send('default', {
        type: 'event',
        from: clientId,
        event
    });
    res.json({ ok: true });
});

router.post('/api/realtime/request-update', async (req, res) => {
    const { targetId, update, from } = req.body;
    await realtime.send('default', {
        type: 'presenceRequest',
        targetId,
        update,
        from
    });
    res.json({ ok: true });
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

