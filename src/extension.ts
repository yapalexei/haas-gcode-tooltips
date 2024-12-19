// src/extension.ts
import * as vscode from 'vscode';
import axios from 'axios';
import * as cheerio from 'cheerio';
import * as fs from 'fs';
import * as path from 'path';

interface CacheData {
    [key: string]: {
        content: string;
        timestamp: number;
    };
}

export function activate(context: vscode.ExtensionContext) {
    // Get cache file path in extension's global storage
    const cacheFile = path.join(context.globalStorageUri.fsPath, 'gcode-cache.json');
    
    // Ensure the directory exists
    if (!fs.existsSync(path.dirname(cacheFile))) {
        fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    }

    // Initialize cache
    let cache: CacheData = {};
    if (fs.existsSync(cacheFile)) {
        try {
            cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        } catch (error) {
            console.error('Error reading cache file:', error);
            cache = {};
        }
    }

    // Cache duration (7 days in milliseconds)
    const CACHE_DURATION = 7 * 24 * 60 * 60 * 1000;

    // Function to save cache
    const saveCache = () => {
        try {
            fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
        } catch (error) {
            console.error('Error writing cache file:', error);
        }
    };

    // Clean old cache entries on activation
    const now = Date.now();
    let cacheUpdated = false;
    for (const key in cache) {
        if (now - cache[key].timestamp > CACHE_DURATION) {
            delete cache[key];
            cacheUpdated = true;
        }
    }
    if (cacheUpdated) {
        saveCache();
    }

    // Register hover provider for .nc files
    const hoverProvider = vscode.languages.registerHoverProvider({ scheme: 'file', language: 'gcode' }, {
        async provideHover(document: vscode.TextDocument, position: vscode.Position) {
            // Get the word under cursor
            const wordRange = document.getWordRangeAtPosition(position);
            if (!wordRange) {
                return null;
            }

            const word = document.getText(wordRange);
            
            // Check if word starts with G or M
            if (!word.match(/^[GM]\d+/i)) {
                return null;
            }

            // Normalize the code (e.g., G1 -> G01)
            const normalizedCode = normalizeGCode(word);
            if (!normalizedCode) {
                return null;
            }

            try {
                let content: string | null;

                // Check cache first
                if (cache[normalizedCode] && 
                    (now - cache[normalizedCode].timestamp) <= CACHE_DURATION) {
                    content = cache[normalizedCode].content;
                } else {
                    // Fetch fresh content if not in cache or expired
                    content = await fetchDocumentation(normalizedCode);
                    if (content) {
                        // Update cache
                        cache[normalizedCode] = {
                            content,
                            timestamp: now
                        };
                        saveCache();
                    }
                }

                if (content) {
                    // Create markdown string for hover
                    const markdownContent = new vscode.MarkdownString();
                    markdownContent.supportHtml = true;
                    markdownContent.appendMarkdown(content);
                    
                    return new vscode.Hover(markdownContent);
                }
            } catch (error) {
                console.error('Error fetching documentation:', error);
                return null;
            }
        }
    });

    context.subscriptions.push(hoverProvider);
}

function normalizeGCode(code: string): string | null {
    const match = code.match(/^([GM])(\d+)/i);
    if (!match) {
        return null;
    }

    const [, type, number] = match;
    // Pad number with leading zero if single digit
    const paddedNumber = number.padStart(2, '0');
    return `${type.toUpperCase()}${paddedNumber}`;
}

async function fetchDocumentation(code: string): Promise<string | null> {
    try {
        // Determine if it's a G-code or M-code
        const codeType = code.startsWith('G') ? 'gcode' : 'mcode';
        
        // Construct URL
        const url = `https://www.haascnc.com/service/codes-settings.type=${codeType}.machine=mill.value=${code}.html`;
        
        // Fetch the page
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0',
                'Accept': 'text/html'
            }
        });
        
        // Load HTML content
        const $ = cheerio.load(response.data);
        
        // Extract content from the specific div
        const content = $('.code-setting-detail-content-inner').html();
        
        if (!content) {
            return null;
        }

        // Clean up the HTML content and convert it to markdown
        return cleanHtmlContent(content);
    } catch (error) {
        console.error('Error fetching documentation:', error);
        return null;
    }
}

function cleanHtmlContent(html: string): string {
    // Remove unnecessary HTML tags and convert to simplified markdown
    // This is a basic implementation - you might want to enhance it based on the actual HTML structure
    return html
        .replace(/<[^>]*>/g, '') // Remove HTML tags
        .replace(/&nbsp;/g, ' ')  // Replace &nbsp; with spaces
        .replace(/\n\s*\n/g, '\n\n') // Remove extra newlines
        .trim();
}

export function deactivate() {}