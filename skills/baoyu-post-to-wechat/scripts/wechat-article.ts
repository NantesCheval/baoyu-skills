import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { launchChrome, tryConnectExisting, findExistingChromeDebugPort, getPageSession, waitForNewTab, clickElement, typeText, evaluate, sleep, type ChromeSession, type CdpConnection } from './cdp.ts';

const WECHAT_URL = 'https://mp.weixin.qq.com/';
const BODY_EDITOR_SELECTOR = '.mock-iframe-body .ProseMirror';

interface ImageInfo {
  placeholder: string;
  localPath: string;
  originalPath: string;
}

interface ArticleOptions {
  title: string;
  content?: string;
  htmlFile?: string;
  markdownFile?: string;
  theme?: string;
  author?: string;
  summary?: string;
  images?: string[];
  contentImages?: ImageInfo[];
  submit?: boolean;
  cover?: boolean;
  profileDir?: string;
  cdpPort?: number;
}

async function waitForLogin(session: ChromeSession, timeoutMs = 120_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const url = await evaluate<string>(session, 'window.location.href');
    if (url.includes('/cgi-bin/home')) return true;
    await sleep(2000);
  }
  return false;
}

async function waitForElement(session: ChromeSession, selector: string, timeoutMs = 10_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = await evaluate<boolean>(session, `!!document.querySelector('${selector}')`);
    if (found) return true;
    await sleep(500);
  }
  return false;
}

async function clickMenuByText(session: ChromeSession, text: string): Promise<void> {
  console.log(`[wechat] Clicking "${text}" menu...`);
  const posResult = await session.cdp.send<{ result: { value: string } }>('Runtime.evaluate', {
    expression: `
      (function() {
        const items = document.querySelectorAll('.new-creation__menu .new-creation__menu-item');
        for (const item of items) {
          const title = item.querySelector('.new-creation__menu-title');
          if (title && title.textContent?.trim() === '${text}') {
            item.scrollIntoView({ block: 'center' });
            const rect = item.getBoundingClientRect();
            return JSON.stringify({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
          }
        }
        return 'null';
      })()
    `,
    returnByValue: true,
  }, { sessionId: session.sessionId });

  if (posResult.result.value === 'null') throw new Error(`Menu "${text}" not found`);
  const pos = JSON.parse(posResult.result.value);

  await session.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 }, { sessionId: session.sessionId });
  await sleep(100);
  await session.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 }, { sessionId: session.sessionId });
}

async function copyImageToClipboard(imagePath: string): Promise<void> {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const copyScript = path.join(__dirname, './copy-to-clipboard.ts');
  const result = spawnSync('npx', ['-y', 'bun', copyScript, 'image', imagePath], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`Failed to copy image: ${imagePath}`);
}

async function pasteInEditor(session: ChromeSession): Promise<void> {
  const modifiers = process.platform === 'darwin' ? 4 : 2;
  await session.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'v', code: 'KeyV', modifiers, windowsVirtualKeyCode: 86 }, { sessionId: session.sessionId });
  await sleep(50);
  await session.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'v', code: 'KeyV', modifiers, windowsVirtualKeyCode: 86 }, { sessionId: session.sessionId });
}

function activateChrome(): void {
  if (process.platform === 'darwin') {
    spawnSync('osascript', ['-e', 'tell application "Google Chrome" to activate']);
    const { execSync } = require('node:child_process');
    try { execSync('sleep 0.3'); } catch {}
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function sendCopy(cdp?: CdpConnection, sessionId?: string): Promise<void> {
  if (cdp && sessionId) {
    // Use CDP directly to target the correct tab, regardless of OS window focus
    const modifiers = process.platform === 'darwin' ? 4 : 2;
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'c', code: 'KeyC', modifiers, windowsVirtualKeyCode: 67 }, { sessionId });
    await sleep(50);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'c', code: 'KeyC', modifiers, windowsVirtualKeyCode: 67 }, { sessionId });
  } else if (process.platform === 'darwin') {
    activateChrome();
    spawnSync('osascript', ['-e', 'tell application "System Events" to keystroke "c" using command down']);
  } else if (process.platform === 'linux') {
    spawnSync('xdotool', ['key', 'ctrl+c']);
  }
}

async function sendPaste(cdp?: CdpConnection, sessionId?: string): Promise<void> {
  if (process.platform === 'darwin') {
    activateChrome();
    spawnSync('osascript', ['-e', 'tell application "System Events" to keystroke "v" using command down']);
  } else if (process.platform === 'linux') {
    spawnSync('xdotool', ['key', 'ctrl+v']);
  } else if (cdp && sessionId) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'v', code: 'KeyV', modifiers: 2, windowsVirtualKeyCode: 86 }, { sessionId });
    await sleep(50);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'v', code: 'KeyV', modifiers: 2, windowsVirtualKeyCode: 86 }, { sessionId });
  }
}

async function copyHtmlFromBrowser(cdp: CdpConnection, htmlFilePath: string, contentImages: ImageInfo[] = []): Promise<void> {
  const absolutePath = path.isAbsolute(htmlFilePath) ? htmlFilePath : path.resolve(process.cwd(), htmlFilePath);
  const fileUrl = `file://${absolutePath}`;

  console.log(`[wechat] Opening HTML file in new tab: ${fileUrl}`);

  const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: fileUrl });
  const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });

  await cdp.send('Page.enable', {}, { sessionId });
  await cdp.send('Runtime.enable', {}, { sessionId });
  await sleep(2000);

  if (contentImages.length > 0) {
    console.log('[wechat] Replacing img tags with placeholders for browser paste...');
    const replacements = contentImages.map(img => ({ placeholder: img.placeholder, localPath: img.localPath }));
    await cdp.send<{ result: { value: unknown } }>('Runtime.evaluate', {
      expression: `
        (function() {
          const replacements = ${JSON.stringify(replacements)};
          for (const r of replacements) {
            const imgs = document.querySelectorAll('img[src="' + r.placeholder + '"], img[data-local-path="' + r.localPath + '"]');
            for (const img of imgs) {
              const text = document.createTextNode(r.placeholder);
              img.parentNode.replaceChild(text, img);
            }
          }
          return true;
        })()
      `,
      returnByValue: true,
    }, { sessionId });
    await sleep(500);
  }

  console.log('[wechat] Selecting #output content...');
  await cdp.send<{ result: { value: unknown } }>('Runtime.evaluate', {
    expression: `
      (function() {
        const output = document.querySelector('#output') || document.body;
        const range = document.createRange();
        range.selectNodeContents(output);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        return true;
      })()
    `,
    returnByValue: true,
  }, { sessionId });
  await sleep(300);

  console.log('[wechat] Copying content...');
  await cdp.send<{ result: { value: unknown } }>('Runtime.evaluate', {
    expression: `document.execCommand('copy')`,
    returnByValue: true,
  }, { sessionId });
  await sleep(1000);

  console.log('[wechat] Closing HTML tab...');
  await cdp.send('Target.closeTarget', { targetId });
  await sleep(500);
}

async function pasteFromClipboardInEditor(session: ChromeSession): Promise<void> {
  console.log('[wechat] Pasting content...');
  // Use CDP directly to avoid osascript activating the wrong Chrome window
  const modifiers = process.platform === 'darwin' ? 4 : 2; // 4=Meta(Cmd) on macOS
  await session.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'v', code: 'KeyV', modifiers, windowsVirtualKeyCode: 86 }, { sessionId: session.sessionId });
  await sleep(50);
  await session.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'v', code: 'KeyV', modifiers, windowsVirtualKeyCode: 86 }, { sessionId: session.sessionId });
  await sleep(1000);
}

async function parseMarkdownWithPlaceholders(markdownPath: string, theme?: string): Promise<{ title: string; author: string; summary: string; htmlPath: string; contentImages: ImageInfo[] }> {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const mdToWechatScript = path.join(__dirname, 'md-to-wechat.ts');
  const args = ['-y', 'bun', mdToWechatScript, markdownPath];
  if (theme) args.push('--theme', theme);

  const result = spawnSync('npx', args, { stdio: ['inherit', 'pipe', 'pipe'] });
  if (result.status !== 0) {
    const stderr = result.stderr?.toString() || '';
    throw new Error(`Failed to parse markdown: ${stderr}`);
  }

  const output = result.stdout.toString();
  return JSON.parse(output);
}

function parseHtmlMeta(htmlPath: string): { title: string; author: string; summary: string; contentImages: ImageInfo[] } {
  const content = fs.readFileSync(htmlPath, 'utf-8');

  let title = '';
  const titleMatch = content.match(/<title>([^<]+)<\/title>/i);
  if (titleMatch) title = titleMatch[1]!;

  let author = '';
  const authorMatch = content.match(/<meta\s+name=["']author["']\s+content=["']([^"']+)["']/i)
    || content.match(/<meta\s+content=["']([^"']+)["']\s+name=["']author["']/i);
  if (authorMatch) author = authorMatch[1]!;

  let summary = '';
  const descMatch = content.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i)
    || content.match(/<meta\s+content=["']([^"']+)["']\s+name=["']description["']/i);
  if (descMatch) summary = descMatch[1]!;

  if (!summary) {
    const firstPMatch = content.match(/<p[^>]*>([^<]+)<\/p>/i);
    if (firstPMatch) {
      const text = firstPMatch[1]!.replace(/<[^>]+>/g, '').trim();
      if (text.length > 20) {
        summary = text.length > 120 ? text.slice(0, 117) + '...' : text;
      }
    }
  }

  const mdPath = htmlPath.replace(/\.html$/i, '.md');
  if (fs.existsSync(mdPath)) {
    const mdContent = fs.readFileSync(mdPath, 'utf-8');
    const fmMatch = mdContent.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (fmMatch) {
      const lines = fmMatch[1]!.split('\n');
      for (const line of lines) {
        const colonIdx = line.indexOf(':');
        if (colonIdx > 0) {
          const key = line.slice(0, colonIdx).trim();
          let value = line.slice(colonIdx + 1).trim();
          if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
          }
          if (key === 'title' && !title) title = value;
          if (key === 'author' && !author) author = value;
          if ((key === 'description' || key === 'summary') && !summary) summary = value;
        }
      }
    }
  }

  const contentImages: ImageInfo[] = [];
  const imgRegex = /<img[^>]*\ssrc=["']([^"']+)["'][^>]*>/gi;
  const matches = [...content.matchAll(imgRegex)];
  for (const match of matches) {
    const [fullTag, src] = match;
    if (!src || src.startsWith('http')) continue;
    const localPathMatch = fullTag.match(/data-local-path=["']([^"']+)["']/);
    if (localPathMatch) {
      contentImages.push({
        placeholder: src,
        localPath: localPathMatch[1]!,
        originalPath: src,
      });
    }
  }

  return { title, author, summary, contentImages };
}

async function selectAndReplacePlaceholder(session: ChromeSession, placeholder: string): Promise<boolean> {
  const result = await session.cdp.send<{ result: { value: boolean } }>('Runtime.evaluate', {
    expression: `
      (function() {
        const editor = document.querySelector('.mock-iframe-body .ProseMirror');
        if (!editor) return false;

        const placeholder = ${JSON.stringify(placeholder)};
        const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, null, false);
        let node;

        while ((node = walker.nextNode())) {
          const text = node.textContent || '';
          let searchStart = 0;
          let idx;
          // Search for exact match (not prefix of longer placeholder like XIMGPH_1 in XIMGPH_10)
          while ((idx = text.indexOf(placeholder, searchStart)) !== -1) {
            const afterIdx = idx + placeholder.length;
            const charAfter = text[afterIdx];
            // Exact match if next char is not a digit
            if (charAfter === undefined || !/\\d/.test(charAfter)) {
              node.parentElement.scrollIntoView({ behavior: 'smooth', block: 'center' });

              const range = document.createRange();
              range.setStart(node, idx);
              range.setEnd(node, idx + placeholder.length);
              const sel = window.getSelection();
              sel.removeAllRanges();
              sel.addRange(range);
              return true;
            }
            searchStart = afterIdx;
          }
        }
        return false;
      })()
    `,
    returnByValue: true,
  }, { sessionId: session.sessionId });

  return result.result.value;
}

async function pressDeleteKey(session: ChromeSession): Promise<void> {
  await session.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }, { sessionId: session.sessionId });
  await sleep(50);
  await session.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }, { sessionId: session.sessionId });
}

async function removeExtraEmptyLineAfterImage(session: ChromeSession): Promise<boolean> {
  const removed = await evaluate<boolean>(session, `
    (function() {
      const editor = document.querySelector('.mock-iframe-body .ProseMirror');
      if (!editor) return false;

      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return false;

      let node = sel.anchorNode;
      if (!node) return false;
      let element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
      if (!element || !editor.contains(element)) return false;

      const isEmptyParagraph = (el) => {
        if (!el || el.tagName !== 'P') return false;
        const text = (el.textContent || '').trim();
        if (text.length > 0) return false;
        return el.querySelectorAll('img, figure, video, iframe').length === 0;
      };

      const hasImage = (el) => {
        if (!el) return false;
        return !!el.querySelector('img, figure img, picture img');
      };

      const placeCursorAfter = (el) => {
        if (!el) return;
        const range = document.createRange();
        range.setStartAfter(el);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      };

      // Case 1: caret is inside an empty paragraph right after an image block.
      const emptyPara = element.closest('p');
      if (emptyPara && editor.contains(emptyPara) && isEmptyParagraph(emptyPara)) {
        const prev = emptyPara.previousElementSibling;
        if (prev && hasImage(prev)) {
          emptyPara.remove();
          placeCursorAfter(prev);
          return true;
        }
      }

      // Case 2: caret is on the image block itself; remove the next empty paragraph.
      const imageBlock = element.closest('figure, p');
      if (imageBlock && editor.contains(imageBlock) && hasImage(imageBlock)) {
        const next = imageBlock.nextElementSibling;
        if (next && isEmptyParagraph(next)) {
          next.remove();
          placeCursorAfter(imageBlock);
          return true;
        }
      }

      return false;
    })()
  `);

  if (removed) console.log('[wechat] Removed extra empty line after image.');
  return removed;
}

async function generateCoverImage(title: string): Promise<string | null> {
  const coverPath = `/tmp/wechat-cover-${Date.now()}.png`;
  const py = `
import sys
try:
    from PIL import Image, ImageDraw, ImageFont
    img = Image.new('RGB', (900, 383), (24, 64, 148))
    draw = ImageDraw.Draw(img)
    font = None
    for fp in ['/System/Library/Fonts/STHeiti Medium.ttc', '/System/Library/Fonts/STHeiti Light.ttc']:
        try: font = ImageFont.truetype(fp, 52); break
        except: pass
    if not font: font = ImageFont.load_default()
    title = sys.argv[1]
    lines, line = [], ''
    for ch in title:
        test = line + ch
        bb = draw.textbbox((0,0), test, font=font)
        if bb[2]-bb[0] > 820 and line: lines.append(line); line = ch
        else: line = test
    if line: lines.append(line)
    th = len(lines) * 70
    y = (383 - th) // 2
    for ln in lines:
        bb = draw.textbbox((0,0), ln, font=font)
        x = (900 - (bb[2]-bb[0])) // 2
        draw.text((x+2, y+2), ln, fill=(0,0,0), font=font)
        draw.text((x, y), ln, fill=(255,255,255), font=font)
        y += 70
    img.save(sys.argv[2])
except Exception as e:
    import sys as _s; print('err:', e, file=_s.stderr); _s.exit(1)
`;
  const r = spawnSync('python3', ['-c', py, title, coverPath], { stdio: ['inherit', 'pipe', 'pipe'] });
  if (r.status === 0 && fs.existsSync(coverPath)) return coverPath;
  return null;
}

async function setCoverImage(session: ChromeSession, cdp: CdpConnection, targetId: string, title: string): Promise<void> {
  console.log('[wechat] Generating cover image...');
  const coverPath = await generateCoverImage(title);
  if (!coverPath) { console.warn('[wechat] Cover image generation failed, skipping.'); return; }

  console.log('[wechat] Uploading cover image...');
  try { await session.cdp.send('Page.setInterceptFileChooser', { enabled: true }, { sessionId: session.sessionId }); } catch {}

  const coverClicked = await evaluate<boolean>(session, `
    (function() {
      const sels = ['#js_cover_chooser .js_editor_cover_inner', '#js_cover_chooser', '.cover-add', '.article-content_cover'];
      for (const s of sels) { const el = document.querySelector(s); if (el) { el.click(); return true; } }
      return false;
    })()`);

  if (!coverClicked) {
    console.warn('[wechat] Cover image area not found, skipping.');
    try { fs.unlinkSync(coverPath); } catch {}
    return;
  }
  await sleep(1000);

  try {
    await session.cdp.send('Page.handleFileChooser', {
      action: 'accept',
      files: [path.resolve(coverPath)],
    }, { sessionId: session.sessionId });
    console.log('[wechat] Cover image uploaded.');
    await sleep(2000);
  } catch (e) {
    console.warn('[wechat] File chooser not triggered:', e);
  }
  try { fs.unlinkSync(coverPath); } catch {}
}

async function tryPublish(session: ChromeSession): Promise<void> {
  console.log('[wechat] Looking for publish button...');
  const clicked = await evaluate<boolean>(session, `
    (function() {
      const btns = document.querySelectorAll('button');
      for (const btn of btns) {
        const t = (btn.textContent || '').trim();
        if (t === '发表' || t === '群发' || t === '发布') { btn.click(); return true; }
      }
      return false;
    })()`);

  if (!clicked) { console.log('[wechat] No publish button found, article saved as draft.'); return; }
  await sleep(2000);

  const confirmed = await evaluate<boolean>(session, `
    (function() {
      const btns = document.querySelectorAll('button');
      for (const btn of btns) {
        const t = (btn.textContent || '').trim();
        if (t === '确定' || t === '确认' || t === '确认发表' || t.includes('发送')) { btn.click(); return true; }
      }
      return false;
    })()`);

  if (confirmed) { console.log('[wechat] Article published!'); await sleep(3000); }
  else { console.log('[wechat] Article saved as draft.'); }
}

export async function postArticle(options: ArticleOptions): Promise<void> {
  const { title, content, htmlFile, markdownFile, theme, author, summary, images = [], submit = false, cover = false, profileDir, cdpPort } = options;
  let { contentImages = [] } = options;
  let effectiveTitle = title || '';
  let effectiveAuthor = author || '';
  let effectiveSummary = summary || '';
  let effectiveHtmlFile = htmlFile;

  if (markdownFile) {
    console.log(`[wechat] Parsing markdown: ${markdownFile}`);
    const parsed = await parseMarkdownWithPlaceholders(markdownFile, theme);
    effectiveTitle = effectiveTitle || parsed.title;
    effectiveAuthor = effectiveAuthor || parsed.author;
    effectiveSummary = effectiveSummary || parsed.summary;
    effectiveHtmlFile = parsed.htmlPath;
    contentImages = parsed.contentImages;
    console.log(`[wechat] Title: ${effectiveTitle || '(empty)'}`);
    console.log(`[wechat] Author: ${effectiveAuthor || '(empty)'}`);
    console.log(`[wechat] Summary: ${effectiveSummary || '(empty)'}`);
    console.log(`[wechat] Found ${contentImages.length} images to insert`);
  } else if (htmlFile && fs.existsSync(htmlFile)) {
    console.log(`[wechat] Parsing HTML: ${htmlFile}`);
    const meta = parseHtmlMeta(htmlFile);
    effectiveTitle = effectiveTitle || meta.title;
    effectiveAuthor = effectiveAuthor || meta.author;
    effectiveSummary = effectiveSummary || meta.summary;
    effectiveHtmlFile = htmlFile;
    if (meta.contentImages.length > 0) {
      contentImages = meta.contentImages;
    }
    console.log(`[wechat] Title: ${effectiveTitle || '(empty)'}`);
    console.log(`[wechat] Author: ${effectiveAuthor || '(empty)'}`);
    console.log(`[wechat] Summary: ${effectiveSummary || '(empty)'}`);
    console.log(`[wechat] Found ${contentImages.length} images to insert`);
  }

  if (effectiveTitle && effectiveTitle.length > 64) throw new Error(`Title too long: ${effectiveTitle.length} chars (max 64)`);
  if (!content && !effectiveHtmlFile) throw new Error('Either --content, --html, or --markdown is required');

  let cdp: CdpConnection;
  let chrome: ReturnType<typeof import('node:child_process').spawn> | null = null;

  // Try connecting to existing Chrome: explicit port > fixed 9222 > auto-detect > launch new
  const DEFAULT_CDP_PORT = 9222;
  let portToTry = cdpPort ?? null;
  if (!portToTry) {
    const fixed = await tryConnectExisting(DEFAULT_CDP_PORT);
    if (fixed) {
      portToTry = DEFAULT_CDP_PORT;
    } else {
      portToTry = await findExistingChromeDebugPort();
    }
  }
  if (portToTry) {
    const existing = await tryConnectExisting(portToTry);
    if (existing) {
      console.log(`[cdp] Connected to existing Chrome on port ${portToTry}`);
      cdp = existing;
    } else {
      console.log(`[cdp] Port ${portToTry} not available, launching new Chrome...`);
      const launched = await launchChrome(WECHAT_URL, profileDir);
      cdp = launched.cdp;
      chrome = launched.chrome;
    }
  } else {
    const launched = await launchChrome(WECHAT_URL, profileDir);
    cdp = launched.cdp;
    chrome = launched.chrome;
  }

  try {
    console.log('[wechat] Waiting for page load...');
    await sleep(3000);

    let session: ChromeSession;
    if (!chrome) {
      // Reusing existing Chrome: clean up all non-home WeChat tabs first
      const allTargets = await cdp.send<{ targetInfos: Array<{ targetId: string; url: string; type: string }> }>('Target.getTargets');
      const wechatTabs = allTargets.targetInfos.filter(t => t.type === 'page' && t.url.includes('mp.weixin.qq.com'));
      const homeTabs = wechatTabs.filter(t => t.url.includes('/cgi-bin/home') || t.url.replace(/\/$/, '') === 'https://mp.weixin.qq.com');
      const nonHomeTabs = wechatTabs.filter(t => !t.url.includes('/cgi-bin/home') && t.url.replace(/\/$/, '') !== 'https://mp.weixin.qq.com');

      // Close all non-home WeChat tabs
      for (const tab of nonHomeTabs) {
        console.log(`[wechat] Closing stale tab: ${tab.url.substring(0, 60)}...`);
        try { await cdp.send('Target.closeTarget', { targetId: tab.targetId }); } catch {}
        await sleep(300);
      }

      // Close duplicate home tabs (keep only the first)
      for (let i = 1; i < homeTabs.length; i++) {
        console.log('[wechat] Closing duplicate home tab...');
        try { await cdp.send('Target.closeTarget', { targetId: homeTabs[i]!.targetId }); } catch {}
        await sleep(300);
      }

      // Re-fetch targets after cleanup
      const remainingTargets = await cdp.send<{ targetInfos: Array<{ targetId: string; url: string; type: string }> }>('Target.getTargets');
      const remainingHome = remainingTargets.targetInfos.find(t => t.type === 'page' && t.url.includes('mp.weixin.qq.com') && t.url.includes('/cgi-bin/home'));
      const anyWechatTab = remainingHome || remainingTargets.targetInfos.find(t => t.type === 'page' && t.url.includes('mp.weixin.qq.com'));

      if (anyWechatTab) {
        console.log(`[wechat] Reusing tab: ${anyWechatTab.url.substring(0, 80)}...`);
        const { sessionId: reuseSid } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId: anyWechatTab.targetId, flatten: true });
        await cdp.send('Page.enable', {}, { sessionId: reuseSid });
        await cdp.send('Runtime.enable', {}, { sessionId: reuseSid });
        await cdp.send('DOM.enable', {}, { sessionId: reuseSid });
        session = { cdp, sessionId: reuseSid, targetId: anyWechatTab.targetId };

        // Navigate to home if not already there, preserving token
        const currentUrl = await evaluate<string>(session, 'window.location.href');
        if (!currentUrl.includes('/cgi-bin/home')) {
          const tokenMatch = currentUrl.match(/token=(\d+)/);
          const tokenParam = tokenMatch ? `&token=${tokenMatch[1]}&lang=zh_CN` : '';
          console.log('[wechat] Navigating to home...');
          await evaluate(session, `window.location.href = '${WECHAT_URL}cgi-bin/home?t=home/index${tokenParam}'`);
          await sleep(5000);
        }
      } else {
        // No WeChat tab found, create one
        console.log('[wechat] No WeChat tab found, opening...');
        await cdp.send('Target.createTarget', { url: WECHAT_URL });
        await sleep(5000);
        session = await getPageSession(cdp, 'mp.weixin.qq.com');
      }
    } else {
      session = await getPageSession(cdp, 'mp.weixin.qq.com');
    }

    const url = await evaluate<string>(session, 'window.location.href');
    const pageHasError = await evaluate<boolean>(session, `document.body.classList.contains('page_error') || document.body.classList.contains('page_timeout')`);
    const sessionExpired = await evaluate<boolean>(session, `(document.body.innerText || '').includes('请重新登录') || /\\/cgi-bin\\/(loginpage|bizlogin)/.test(window.location.href)`);
    if (!url.includes('/cgi-bin/') || pageHasError || !url.includes('token=') || sessionExpired) {
      console.log('[wechat] Not logged in. Please scan QR code...');
      await evaluate(session, `window.location.href = '${WECHAT_URL}'`);
      await sleep(3000);
      const loggedIn = await waitForLogin(session);
      if (!loggedIn) throw new Error('Login timeout');
    }
    console.log('[wechat] Logged in.');
    await sleep(2000);

    // Extract token from current URL and navigate directly to create article page
    const currentUrl = await evaluate<string>(session, 'window.location.href');
    const tokenMatch = currentUrl.match(/token=(\d+)/);
    if (!tokenMatch) throw new Error('Could not extract token from URL');
    const token = tokenMatch[1];
    const createUrl = `https://mp.weixin.qq.com/cgi-bin/appmsg?action=edit&type=10&token=${token}&lang=zh_CN`;

    const targets0 = await cdp.send<{ targetInfos: Array<{ targetId: string; url: string; type: string }> }>('Target.getTargets');
    const initialIds = new Set(targets0.targetInfos.map(t => t.targetId));

    console.log('[wechat] Opening editor tab directly...');
    await cdp.send('Target.createTarget', { url: createUrl });
    await sleep(4000);

    const editorTargetId = await waitForNewTab(cdp, initialIds, 'mp.weixin.qq.com');
    console.log('[wechat] Editor tab opened.');

    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId: editorTargetId, flatten: true });
    session = { cdp, sessionId, targetId: editorTargetId };

    await cdp.send('Page.enable', {}, { sessionId });
    await cdp.send('Runtime.enable', {}, { sessionId });
    await cdp.send('DOM.enable', {}, { sessionId });

    await sleep(3000);
    let editorReady = false;
    let titleReady = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      editorReady = await waitForElement(session, BODY_EDITOR_SELECTOR, 20_000);
      titleReady = await waitForElement(session, '#title', 5_000);
      if (editorReady && titleReady) break;
      if (attempt < 3) {
        console.warn(`[wechat] Editor not ready (attempt ${attempt}/3), reloading editor page...`);
        await cdp.send('Page.navigate', { url: createUrl }, { sessionId });
        await sleep(5000);
      }
    }
    if (!editorReady) throw new Error(`Editor not ready: ${BODY_EDITOR_SELECTOR}`);
    if (!titleReady) throw new Error('Title input not ready: #title');

    if (effectiveTitle) {
      console.log('[wechat] Filling title...');
      await evaluate(session, `
        (function() {
          const title = ${JSON.stringify(effectiveTitle)};
          const legacyInput = document.querySelector('#title');
          if (legacyInput) {
            legacyInput.value = title;
            legacyInput.dispatchEvent(new Event('input', { bubbles: true }));
            legacyInput.dispatchEvent(new Event('change', { bubbles: true }));
          }

          // New WeChat editor renders a visible ProseMirror title editor
          // separately from the legacy textarea. Keep both in sync.
          const richTitle = document.querySelector('.title-editor__input .ProseMirror');
          if (richTitle) {
            richTitle.textContent = title;
            richTitle.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: title }));
          }
        })()
      `);
    }

    if (effectiveAuthor) {
      console.log('[wechat] Filling author...');
      await evaluate(session, `
        (function() {
          const author = ${JSON.stringify(effectiveAuthor)};
          const input = document.querySelector('#author');
          if (!input) return;
          input.focus();
          input.value = author;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          input.blur();
        })()
      `);
    }

    await sleep(500);

    if (effectiveTitle) {
      const actualTitle = await evaluate<string>(session, `
        document.querySelector('.title-editor__input .ProseMirror')?.innerText?.trim()
          || document.querySelector('#title')?.value
          || ''
      `);
      if (actualTitle === effectiveTitle) {
        console.log('[wechat] Title verified OK.');
      } else {
        console.warn(`[wechat] Title verification failed. Expected: "${effectiveTitle}", got: "${actualTitle}"`);
      }
    }

    if (effectiveAuthor) {
      const actualAuthor = await evaluate<string>(session, `document.querySelector('#author')?.value || ''`);
      if (actualAuthor === effectiveAuthor) {
        console.log('[wechat] Author verified OK.');
      } else {
        console.warn(`[wechat] Author verification failed. Expected: "${effectiveAuthor}", got: "${actualAuthor}"`);
      }
    }

    console.log('[wechat] Clicking on editor...');
    await clickElement(session, BODY_EDITOR_SELECTOR);
    await sleep(1000);

    console.log('[wechat] Ensuring editor focus...');
    await clickElement(session, BODY_EDITOR_SELECTOR);
    await sleep(500);

    if (effectiveHtmlFile && fs.existsSync(effectiveHtmlFile)) {
      // Read HTML content and write to clipboard via Clipboard API in editor tab context
      const absoluteHtmlPath = path.isAbsolute(effectiveHtmlFile) ? effectiveHtmlFile : path.resolve(process.cwd(), effectiveHtmlFile);
      const rawHtml = fs.readFileSync(absoluteHtmlPath, 'utf-8');
      // Extract #output div — find opening tag, then match to its closing </div>
      const startMatch = rawHtml.match(/(<[^>]*\bid=["']output["'][^>]*>)/);
      let htmlContent = rawHtml;
      if (startMatch) {
        const startIdx = rawHtml.indexOf(startMatch[0]);
        // Walk forward counting div nesting to find the matching closing </div>
        let depth = 0, i = startIdx, endIdx = -1;
        while (i < rawHtml.length) {
          if (rawHtml.startsWith('<div', i)) depth++;
          else if (rawHtml.startsWith('</div>', i)) { depth--; if (depth === 0) { endIdx = i + 6; break; } }
          i++;
        }
        if (endIdx > 0) htmlContent = rawHtml.slice(startIdx, endIdx);
      }
      for (const img of contentImages) {
        const placeholder = escapeRegExp(img.placeholder);
        const localPath = escapeRegExp(img.localPath);
        htmlContent = htmlContent.replace(
          new RegExp(`<img\\b(?=[^>]*(?:src=["']${placeholder}["']|data-local-path=["']${localPath}["']))[^>]*>`, 'g'),
          img.placeholder,
        );
      }

      console.log('[wechat] Dispatching paste event with HTML content directly into editor...');
      await cdp.send('Target.activateTarget', { targetId: editorTargetId });
      await sleep(500);
      await clickElement(session, BODY_EDITOR_SELECTOR);
      await sleep(300);
      await session.cdp.send('Runtime.evaluate', {
        expression: `
          (function() {
            const html = ${JSON.stringify(htmlContent)};
            const editor = document.querySelector('.mock-iframe-body .ProseMirror');
            if (!editor) return 'no editor';
            const dt = new DataTransfer();
            dt.setData('text/html', html);
            dt.setData('text/plain', editor.innerText || '');
            const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
            editor.dispatchEvent(ev);
            return 'ok';
          })()
        `,
        returnByValue: true,
      }, { sessionId: session.sessionId });
      await sleep(2000);
      console.log('[wechat] Paste event dispatched.');
      await sleep(3000);

      const editorTextLength = await evaluate<number>(session, `
        (function() {
          const editor = document.querySelector('.mock-iframe-body .ProseMirror');
          if (!editor) return 0;
          return (editor.innerText?.trim() || '').length;
        })()
      `);
      if (editorTextLength > 50) {
        console.log(`[wechat] Body content verified OK (${editorTextLength} chars).`);
      } else {
        console.warn(`[wechat] Body content may be missing: only ${editorTextLength} chars in editor after paste.`);
      }

      if (contentImages.length > 0) {
        console.log(`[wechat] Inserting ${contentImages.length} images...`);
        for (let i = 0; i < contentImages.length; i++) {
          const img = contentImages[i]!;
          console.log(`[wechat] [${i + 1}/${contentImages.length}] Processing: ${img.placeholder}`);

          const found = await selectAndReplacePlaceholder(session, img.placeholder);
          if (!found) {
            console.warn(`[wechat] Placeholder not found: ${img.placeholder}`);
            continue;
          }

          await sleep(500);

          console.log(`[wechat] Copying image: ${path.basename(img.localPath)}`);
          await copyImageToClipboard(img.localPath);
          await sleep(300);

          console.log('[wechat] Deleting placeholder with Backspace...');
          await pressDeleteKey(session);
          await sleep(200);

          console.log('[wechat] Pasting image...');
          await pasteFromClipboardInEditor(session);
          await sleep(3000);
          await removeExtraEmptyLineAfterImage(session);
        }
        console.log('[wechat] All images inserted.');
      }
    } else if (content) {
      for (const img of images) {
        if (fs.existsSync(img)) {
          console.log(`[wechat] Pasting image: ${img}`);
          await copyImageToClipboard(img);
          await sleep(500);
          await pasteInEditor(session);
          await sleep(2000);
          await removeExtraEmptyLineAfterImage(session);
        }
      }

      console.log('[wechat] Typing content...');
      await typeText(session, content);
      await sleep(1000);

      const editorHasContent = await evaluate<boolean>(session, `
        (function() {
          const editor = document.querySelector('.mock-iframe-body .ProseMirror');
          if (!editor) return false;
          const text = editor.innerText?.trim() || '';
          return text.length > 0;
        })()
      `);
      if (editorHasContent) {
        console.log('[wechat] Body content verified OK.');
      } else {
        console.warn('[wechat] Body content verification failed: editor appears empty after typing.');
      }
    }

    if (effectiveSummary) {
      console.log(`[wechat] Filling summary (after content paste): ${effectiveSummary}`);
      await evaluate(session, `
        (function() {
          const el = document.querySelector('#js_description');
          if (!el) return;
          el.focus();
          el.select();
          el.value = ${JSON.stringify(effectiveSummary)};
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new Event('blur', { bubbles: true }));
        })()
      `);
      await sleep(500);

      const actualSummary = await evaluate<string>(session, `document.querySelector('#js_description')?.value || ''`);
      if (actualSummary === effectiveSummary) {
        console.log('[wechat] Summary verified OK.');
      } else {
        console.warn(`[wechat] Summary verification failed. Expected: "${effectiveSummary}", got: "${actualSummary}"`);
      }
    }

    if (cover) {
      await setCoverImage(session, cdp, editorTargetId, effectiveTitle);
    } else {
      console.log('[wechat] Cover skipped (selectors stale; pass --cover to retry).');
    }

    console.log('[wechat] Saving as draft...');
    await evaluate(session, `document.querySelector('#js_submit button').click()`);

    // Wait for save confirmation with retry
    let saveConfirmed = false;
    for (let i = 0; i < 10; i++) {
      await sleep(2000);
      const hasToast = await evaluate<boolean>(session, `!!document.querySelector('.weui-desktop-toast')`);
      const urlChanged = await evaluate<boolean>(session, `window.location.href.includes('appmsgpublish') || window.location.href.includes('appmsg')`);
      if (hasToast || urlChanged) {
        saveConfirmed = true;
        console.log('[wechat] Draft saved successfully!');
        break;
      }
      console.log(`[wechat] Waiting for save confirmation... (${i + 1})`);
    }
    if (!saveConfirmed) {
      console.warn('[wechat] Save confirmation not detected, waiting extra time...');
      await sleep(5000);
    }

    await sleep(3000);
    await tryPublish(session);

    console.log('[wechat] Done. Editor tab kept open.');
  } finally {
    cdp.close();
  }
}

function printUsage(): never {
  console.log(`Post article to WeChat Official Account

Usage:
  npx -y bun wechat-article.ts [options]

Options:
  --title <text>     Article title (auto-extracted from markdown)
  --content <text>   Article content (use with --image)
  --html <path>      HTML file to paste (alternative to --content)
  --markdown <path>  Markdown file to convert and post (recommended)
  --theme <name>     Theme for markdown (default, grace, simple)
  --author <name>    Author name (default: 宝玉)
  --summary <text>   Article summary
  --image <path>     Content image, can repeat (only with --content)
  --submit           Save as draft
  --profile <dir>    Chrome profile directory
  --cdp-port <port>  Connect to existing Chrome debug port instead of launching new instance

Examples:
  npx -y bun wechat-article.ts --markdown article.md
  npx -y bun wechat-article.ts --markdown article.md --theme grace --submit
  npx -y bun wechat-article.ts --title "标题" --content "内容" --image img.png
  npx -y bun wechat-article.ts --title "标题" --html article.html --submit

Markdown mode:
  Images in markdown are converted to placeholders. After pasting HTML,
  each placeholder is selected, scrolled into view, deleted, and replaced
  with the actual image via paste.
`);
  process.exit(0);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) printUsage();

  const images: string[] = [];
  let title: string | undefined;
  let content: string | undefined;
  let htmlFile: string | undefined;
  let markdownFile: string | undefined;
  let theme: string | undefined;
  let author: string | undefined;
  let summary: string | undefined;
  let submit = false;
  let cover = false;
  let profileDir: string | undefined;
  let cdpPort: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--title' && args[i + 1]) title = args[++i];
    else if (arg === '--content' && args[i + 1]) content = args[++i];
    else if (arg === '--html' && args[i + 1]) htmlFile = args[++i];
    else if (arg === '--markdown' && args[i + 1]) markdownFile = args[++i];
    else if (arg === '--theme' && args[i + 1]) theme = args[++i];
    else if (arg === '--author' && args[i + 1]) author = args[++i];
    else if (arg === '--summary' && args[i + 1]) summary = args[++i];
    else if (arg === '--image' && args[i + 1]) images.push(args[++i]!);
    else if (arg === '--submit') submit = true;
    else if (arg === '--cover') cover = true;
    else if (arg === '--profile' && args[i + 1]) profileDir = args[++i];
    else if (arg === '--cdp-port' && args[i + 1]) cdpPort = parseInt(args[++i]!, 10);
  }

  if (!markdownFile && !htmlFile && !title) { console.error('Error: --title is required (or use --markdown/--html)'); process.exit(1); }
  if (!markdownFile && !htmlFile && !content) { console.error('Error: --content, --html, or --markdown is required'); process.exit(1); }

  await postArticle({ title: title || '', content, htmlFile, markdownFile, theme, author, summary, images, submit, cover, profileDir, cdpPort });
}

await main().then(() => {
  process.exit(0);
}).catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
