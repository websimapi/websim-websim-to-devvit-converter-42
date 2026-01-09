import * as acorn from 'https://esm.sh/acorn@8.11.3';
import { simple as walkSimple } from 'https://esm.sh/acorn-walk@8.3.2';
import MagicString from 'https://esm.sh/magic-string@0.30.5';
import { uint8ToString } from './utils.js';
import { normalizeImport } from './imports.js';

export function processJS(jsContent, filename = 'script.js', analyzer) {
    let code = uint8ToString(jsContent);

    // React/JSX Detection: Ensure dependencies are tracked if JSX is present
    if (/<[A-Z][A-Za-z0-9]*[\s>]/g.test(code) || /className=/g.test(code)) {
        if (!analyzer.dependencies['react']) analyzer.dependencies['react'] = '^18.2.0';
        if (!analyzer.dependencies['react-dom']) analyzer.dependencies['react-dom'] = '^18.2.0';
    }
    
    // Generic WebSim URL Replacements (Fix CSP issues & Hot-swap Identity)
    // We replace WebSim avatar URLs with a local placeholder "/_websim_avatar_/username".
    // A client-side polyfill (AvatarInjector) will detect these placeholders and inject the real Snoovatar URL.
    code = code.replace(/https:\/\/images\.websim\.ai\/avatar\/|https:\/\/images\.websim\.com\/avatar\//g, '/_websim_avatar_/');
    
    // Replace full literal avatar strings if found (e.g. "https://.../avatar/someuser")
    code = code.replace(/["']https:\/\/images\.websim\.(ai|com)\/avatar\/([^"']+)["']/g, '"/_websim_avatar_/$2"');

    // Calculate relative path to root for asset corrections
    const depth = (filename.match(/\//g) || []).length;
    const rootPrefix = depth > 0 ? '../'.repeat(depth) : './';

    let ast;
    const magic = new MagicString(code);
    let hasChanges = false;

    // Track definitions for auto-exporting (Legacy Script -> Module support)
    const declaredNames = new Set();
    const exportedNames = new Set();

    try {
        ast = acorn.parse(code, { sourceType: 'module', ecmaVersion: 'latest', allowReturnOutsideFunction: true, allowHashBang: true });
        
        // Pass 1: Collect definitions and exports
        if (ast.body) {
            for (const node of ast.body) {
                if (node.type === 'FunctionDeclaration' && node.id) {
                    declaredNames.add(node.id.name);
                } else if (node.type === 'ClassDeclaration' && node.id) {
                    declaredNames.add(node.id.name);
                } else if (node.type === 'VariableDeclaration') {
                    for (const decl of node.declarations) {
                        if (decl.id.type === 'Identifier') declaredNames.add(decl.id.name);
                    }
                } else if (node.type === 'ExportNamedDeclaration') {
                    if (node.declaration) {
                        if (node.declaration.id) exportedNames.add(node.declaration.id.name);
                        else if (node.declaration.declarations) {
                            node.declaration.declarations.forEach(d => exportedNames.add(d.id.name));
                        }
                    }
                    if (node.specifiers) {
                        node.specifiers.forEach(s => exportedNames.add(s.exported.name));
                    }
                } else if (node.type === 'ExportDefaultDeclaration') {
                    exportedNames.add('default');
                }
            }
        }

        const rewrite = (node) => {
            if (node.source && node.source.value) {
                const newVal = normalizeImport(node.source.value, analyzer.dependencies);
                if (newVal !== node.source.value) {
                    magic.overwrite(node.source.start, node.source.end, JSON.stringify(newVal));
                    hasChanges = true;
                }
            }
        };

        const rewritePaths = (node) => {
            if (node.type === 'Literal' && typeof node.value === 'string') {
                const val = node.value;

                // 1. Check URL Map (Exact Match for external or remapped assets)
                if (analyzer.urlMap.has(val)) {
                    const cleanName = analyzer.urlMap.get(val);
                    // Serve from root (public folder)
                    const newVal = `/${cleanName}`; 
                    magic.overwrite(node.start, node.end, JSON.stringify(newVal));
                    hasChanges = true;
                    return;
                }

                // 2. Handle standard local paths that weren't mapped
                if (val.startsWith('/') && !val.startsWith('//') && /\.(png|jpg|jpeg|gif|mp3|wav|ogg|glb|gltf|svg|json)$/i.test(val)) {
                    const newVal = rootPrefix + val.substring(1);
                    magic.overwrite(node.start, node.end, JSON.stringify(newVal));
                    hasChanges = true;
                }
            }
        };

        walkSimple(ast, {
            ImportDeclaration: rewrite,
            ExportNamedDeclaration: rewrite,
            ExportAllDeclaration: rewrite,
            ImportExpression: (node) => {
                if (node.source.type === 'Literal') {
                    const newVal = normalizeImport(node.source.value, analyzer.dependencies);
                    if (newVal !== node.source.value) {
                        magic.overwrite(node.source.start, node.source.end, JSON.stringify(newVal));
                        hasChanges = true;
                    }
                }
            },
            Literal: rewritePaths,
            TemplateLiteral: (node) => {
                // Smart Swap: Detect Avatar URLs
                // Pattern: `.../avatar/${user.username}` OR `.../_websim_avatar_/${user.username}`
                if (node.quasis.length === 2 && node.expressions.length === 1) {
                    const prefix = node.quasis[0].value.raw;
                    const isWebSim = prefix.includes('images.websim.ai/avatar/') || prefix.includes('images.websim.com/avatar/');
                    const isPlaceholder = prefix.includes('/_websim_avatar_/');
                    
                    if (isWebSim || isPlaceholder) {
                        const expr = node.expressions[0];
                        if (expr.type === 'MemberExpression' && expr.property.type === 'Identifier' && expr.property.name === 'username') {
                            const objectCode = code.slice(expr.object.start, expr.object.end);
                            // Prefer cached avatar_url, fallback to placeholder which Client Injector will swap
                            const replacement = `(${objectCode}.avatar_url || "/_websim_avatar_/" + ${objectCode}.username)`;
                            magic.overwrite(node.start, node.end, replacement);
                            hasChanges = true;
                        }
                    }
                }
            },
            BinaryExpression: (node) => {
                // Smart Swap: Detect Avatar URL Concatenation
                // Pattern: "https://.../avatar/" + post.username
                if (node.operator === '+') {
                    const left = node.left;
                    const right = node.right;
                    
                    if (left.type === 'Literal' && typeof left.value === 'string') {
                        const val = left.value;
                        const isWebSim = val.includes('images.websim.ai/avatar/') || val.includes('images.websim.com/avatar/');
                        const isPlaceholder = val.includes('/_websim_avatar_/');
                        
                        if (isWebSim || isPlaceholder) {
                            if (right.type === 'MemberExpression' && right.property.type === 'Identifier' && right.property.name === 'username') {
                                const objectCode = code.slice(right.object.start, right.object.end);
                                const replacement = `(${objectCode}.avatar_url || "/_websim_avatar_/" + ${objectCode}.username)`;
                                magic.overwrite(node.start, node.end, replacement);
                                hasChanges = true;
                            }
                        }
                    }
                }
            }
        });

        // Pass 2: Auto-Export top-level definitions if not already exported
        // This fixes "X is not exported by Y" errors when converting legacy scripts to modules
        const toExport = [...declaredNames].filter(name => !exportedNames.has(name));
        if (toExport.length > 0) {
            // Append exports at the end
            magic.append(`\n\n// [WebSim] Auto-exported definitions for module compatibility\nexport { ${toExport.join(', ')} };`);
            hasChanges = true;
        }

    } catch (e) {
        // Regex Fallback for JSX or syntax errors (Acorn fails on JSX)
        
        // 1. Rewrite Imports via Regex
        const importRegex = /(import\s+(?:[\w\s{},*]+)\s+from\s+['"])([^'"]+)(['"])|(import\s+['"])([^'"]+)(['"])|(from\s+['"])([^'"]+)(['"])|(import\s*\(\s*['"])([^'"]+)(['"]\s*\))/g;
        let match;
        const originalCode = code; 
        
        while ((match = importRegex.exec(originalCode)) !== null) {
            const url = match[2] || match[5] || match[8] || match[11];
            const prefix = match[1] || match[4] || match[7] || match[10];
            
            if (url) {
                const newVal = normalizeImport(url, analyzer.dependencies);
                if (newVal !== url) {
                    const start = match.index + prefix.length;
                    const end = start + url.length;
                    magic.overwrite(start, end, newVal);
                    hasChanges = true;
                }
            }
        }

        // 2. Regex Fallback for Auto-Exports (if parsing failed)
        // This is critical for files with JSX where Acorn fails but we still need to export top-level helpers
        // Attempt to find top-level function/class/variable declarations
        const declRegex = /^(?:export\s+)?(?:async\s+)?(function|class|const|let|var)\s+([a-zA-Z0-9_$]+)/gm;
        let declMatch;
        const fallbackDeclared = new Set();
        // Reset lastIndex
        declRegex.lastIndex = 0;
        
        while ((declMatch = declRegex.exec(code)) !== null) {
            // declMatch[2] is the identifier
            fallbackDeclared.add(declMatch[2]);
        }

        const safeExports = [];
        fallbackDeclared.forEach(name => {
             // Avoid double export if it's already exported in source
             const checkExport = new RegExp(`export\\s+(?:async\\s+)?(?:function|class|const|let|var)\\s+${name}`, 'm');
             if (!checkExport.test(code)) {
                 safeExports.push(name);
             }
        });

        if (safeExports.length > 0) {
            magic.append(`\n\n// [WebSim] Auto-exported definitions (Regex Fallback)\nexport { ${safeExports.join(', ')} };`);
            hasChanges = true;
        }
    }

    // Remotion License Injection for <Player /> components
    // We iterate all <Player> tags and ensure the prop is present.
    if (code.includes('<Player')) {
            const playerRegex = /<Player([\s\n\r/>])/g;
            let match;
            while ((match = playerRegex.exec(code)) !== null) {
                // Check if the prop already exists in the vicinity (heuristic: next 500 chars)
                // This avoids duplicate injection if the user already added it or if we run multiple times
                const vicinity = code.slice(match.index, match.index + 500);
                const closeIndex = vicinity.indexOf('>');
                const tagContent = closeIndex > -1 ? vicinity.slice(0, closeIndex) : vicinity;
                
                if (!tagContent.includes('acknowledgeRemotionLicense')) {
                    // Insert prop right after <Player, ensuring space
                    magic.appendLeft(match.index + 7, ' acknowledgeRemotionLicense={true}');
                    hasChanges = true;
                }
            }
    }

    return hasChanges ? magic.toString() : code;
}