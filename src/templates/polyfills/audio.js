export const webAudioPolyfill = `
// [WebSim] Audio Polyfill - Reddit/Devvit Compliance & Crash Prevention
(function() {
    console.log("[Audio] Initializing Reddit-compliant Audio Manager...");

    // 1. Context Tracking for Visibility/Unlock
    const contexts = new Set();
    let unlocked = false;

    // Helper: Create a generic silent buffer (1s) to return on error
    function createSilentBuffer(ctx) {
        // Create a tiny buffer (1 sample) just to satisfy the interface
        return ctx.createBuffer(1, 1, 22050);
    }

    // 2. Wrap AudioContext to intercept decodeAudioData and handle suspension
    const NativeAudioContext = window.AudioContext || window.webkitAudioContext;
    
    if (NativeAudioContext) {
        class PolyfillAudioContext extends NativeAudioContext {
            constructor(opts) {
                super(opts);
                contexts.add(this);
                
                // Ensure we start suspended until interaction (browsers mostly do this, but being explicit helps)
                if (this.state === 'running' && !unlocked) {
                    this.suspend().catch(() => {});
                }
            }

            // Safe Decode: Catches malformed buffers (e.g. HTML 404s) preventing app crash
            decodeAudioData(buffer, successCallback, errorCallback) {
                const isPromise = !successCallback && !errorCallback;

                // 1. Validation: If buffer is bad/empty, fail gracefully immediately
                if (!buffer || buffer.byteLength === 0) {
                    console.warn("[Audio] Empty/Null buffer passed to decodeAudioData. Serving silence.");
                    const silent = createSilentBuffer(this);
                    if (successCallback) successCallback(silent);
                    return isPromise ? Promise.resolve(silent) : undefined;
                }

                // 2. Execute Decode
                // We wrap the Promise result to catch errors even if callbacks are used (modern browsers return Promise + callbacks)
                const promise = super.decodeAudioData(buffer, 
                    (decoded) => {
                        if (successCallback) successCallback(decoded);
                    },
                    (err) => {
                        console.warn("[Audio] Decode Error (callback):", err.message);
                        // Serve silence instead of erroring
                        const silent = createSilentBuffer(this);
                        if (successCallback) successCallback(silent);
                        // We suppress the errorCallback to keep game running
                    }
                );

                // 3. Handle Promise Rejection (Common in modern usage)
                if (promise && promise.catch) {
                    return promise.catch(err => {
                        console.warn("[Audio] Decode Error (promise):", err.message);
                        // Return silence
                        const silent = createSilentBuffer(this);
                        // If user provided a success callback, we already called it above in the error handler wrapper if supported,
                        // but if they rely purely on promise:
                        return silent;
                    });
                }
                
                return promise;
            }
        }

        window.AudioContext = PolyfillAudioContext;
        window.webkitAudioContext = PolyfillAudioContext;
    }

    // 3. User Interaction Unlock (Reddit Rule: No Autoplay)
    // We include pointerdown to cover more mobile cases
    const unlockEvents = ['click', 'touchstart', 'keydown', 'mousedown', 'pointerdown'];
    const unlockFn = () => {
        if (unlocked) return;
        unlocked = true;
        console.log("[Audio] Interaction detected. Resuming Audio Contexts...");
        contexts.forEach(ctx => {
            if (ctx.state === 'suspended') {
                ctx.resume().then(() => {
                    console.log("[Audio] Context resumed successfully.");
                }).catch(e => {
                    console.warn("[Audio] Resume failed:", e);
                });
            }
        });
        unlockEvents.forEach(e => window.removeEventListener(e, unlockFn));
    };
    unlockEvents.forEach(e => window.addEventListener(e, unlockFn));

    // 4. Visibility Handling (Reddit Rule: Mute when hidden)
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            console.log("[Audio] App hidden, suspending...");
            contexts.forEach(ctx => ctx.suspend().catch(() => {}));
        } else {
            console.log("[Audio] App visible, resuming...");
            if (unlocked) {
                contexts.forEach(ctx => {
                    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
                });
            }
        }
    });

})();
`;