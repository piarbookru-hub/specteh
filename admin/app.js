'use strict';

if (typeof CMS_CONFIG === 'undefined') {
    document.body.innerHTML = '<p style="padding:40px;color:#ff4444;">Не найден config.js (CMS_CONFIG). Проверьте, что файл лежит рядом с этой страницей.</p>';
    throw new Error('CMS_CONFIG is not defined');
}

const LINK_COLORS = { inherit: null, brown: '#8B4513', lightbrown: '#CD853F' };
const XHTML_NS = 'http://www.w3.org/1999/xhtml';

const PREVIEW_SANDBOX = 'allow-same-origin allow-scripts allow-popups allow-popups-to-escape-sandbox';
const VIEW_SANDBOX = 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox';

const $ = id => document.getElementById(id);

const mkStore = st => ({
    get: k => { try { return st.getItem(k); } catch { return null; } },
    set: (k, v) => { try { st.setItem(k, v); } catch {} },
    del: k => { try { st.removeItem(k); } catch {} }
});
let ls, ss;
try { ls = mkStore(localStorage); } catch { ls = { get: () => null, set() {}, del() {} }; }
try { ss = mkStore(sessionStorage); } catch { ss = { get: () => null, set() {}, del() {} }; }

ls.del('gh_token');
let token = ss.get('gh_token');
let pending = {};
let editKind = null, editKey = null, editImagePath = null, pendingImg = null, statusTimer = null, lastFocus = null;
let editOrigText = null, editOrigImg = null;
let currentFile = ls.get('cms_currentFile') || 'index.html';
let viewModeUrl = null;
let siteBaseUrl = '';
let siteBasePath = '/';
let repoDeployId = null;
let deployPollGen = 0;
const API = `https://api.github.com/repos/${CMS_CONFIG.owner}/${CMS_CONFIG.repo}`;

$('projectNameHeader').textContent = CMS_CONFIG.projectName || 'Редактор';

function saveCurrentFile() { ls.set('cms_currentFile', currentFile); }

try {
    const loc = window.location;
    const pathParts = loc.pathname.split('/').filter(Boolean);
    if (pathParts.length > 0) {
        const lastPart = pathParts[pathParts.length - 1];
        if (lastPart.endsWith('.html')) pathParts.pop();
        const secondLast = pathParts[pathParts.length - 1];
        if (secondLast === 'admin' || secondLast === 'panel') pathParts.pop();
        if (pathParts.length > 0) {
            siteBaseUrl = loc.origin + '/' + pathParts.join('/') + '/';
            siteBasePath = '/' + pathParts.join('/') + '/';
        } else { siteBaseUrl = loc.origin + '/'; siteBasePath = '/'; }
    } else { siteBaseUrl = loc.origin + '/'; siteBasePath = '/'; }
} catch {
    siteBaseUrl = window.location.origin + '/';
    siteBasePath = '/';
}

function siteBasePathNoSlash() {
    return siteBasePath.replace(/\/+$/, '');
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const encPath = p => p.split('/').map(encodeURIComponent).join('/');

function pageUrl(file = currentFile) { return new URL(encPath(file), siteBaseUrl); }

function safeAbs(href) {
    try {
        const u = new URL(href, pageUrl());
        return ['http:', 'https:', 'tel:', 'mailto:'].includes(u.protocol) ? u.href : null;
    } catch { return null; }
}
function openSafe(href) { const u = safeAbs(href); if (u) window.open(u, '_blank', 'noopener'); }
function validLinkUrl(u) {
    if (!u) return true;
    if (u.startsWith('#')) return true;
    return !!safeAbs(u);
}

function isAdminSelf(file) {
    try {
        const norm = p => p.replace(/index\.html?$/i, '').replace(/\/+$/, '');
        const u = new URL(encPath(file), siteBaseUrl);
        return u.origin === window.location.origin && norm(u.pathname) === norm(window.location.pathname);
    } catch { return false; }
}

function resolveRepoPath(src) {
    try {
        const dirUrl = new URL(encPath(currentFile), 'https://repo.local/');
        const u = new URL(src, dirUrl);
        let p = decodeURIComponent(u.pathname);
        if (src.startsWith('/') && siteBasePath !== '/' && p.startsWith(siteBasePath)) p = p.slice(siteBasePath.length);
        p = p.replace(/^\/+/, '');
        return p || null;
    } catch { return null; }
}

function updatePageIndicator() {
    const el = $('currentPageIndicator');
    const box = $('pageIndicatorBox');
    if (!el) return;
    if (viewModeUrl) {
        el.textContent = 'просмотр: ' + viewModeUrl.replace(/^https?:\/\//, '');
        if (box) { box.classList.add('viewmode'); box.title = 'Режим просмотра (без редактирования).'; }
    } else {
        el.textContent = currentFile;
        if (box) { box.classList.remove('viewmode'); box.title = 'Текущая страница (сохраняется при F5)'; }
    }
}

function newDeployId() { return 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

function readDeployId(html) {
    const m = html.match(/<meta\s+name=["']cms-deploy-id["']\s+content=["']([^"']+)["']/i);
    return m ? m[1] : null;
}

function stampDeployId(html, id) {
    const tag = `<meta name="cms-deploy-id" content="${id}">`;
    if (/<meta\s+name=["']cms-deploy-id["']/i.test(html)) {
        return html.replace(/<meta\s+name=["']cms-deploy-id["'][^>]*>/i, tag);
    }
    if (/<meta\s+charset[^>]*>/i.test(html)) return html.replace(/<meta\s+charset[^>]*>/i, m => m + '\n' + tag);
    if (/<head(\s[^>]*)?>/.test(html)) return html.replace(/<head(\s[^>]*)?>/i, m => m + '\n' + tag);
    return html.replace(/^(<!DOCTYPE[^>]*>\s*)?/i, m => m + tag + '\n');
}

function setDeployBadge(state, html) {
    const b = $('deployBadge');
    if (!b) return;
    if (state === 'idle') { b.className = 'deploy-badge'; b.style.display = 'none'; b.innerHTML = ''; return; }
    b.className = 'deploy-badge ' + state;
    b.style.display = 'inline-flex';
    b.innerHTML = html;
}

async function fetchLiveDeployId() {
    const u = pageUrl();
    u.searchParams.set('cb', Date.now());
    const res = await fetch(u.href, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return readDeployId(await res.text());
}

async function verifyDeploy(expectedId, singleCheck) {
    const gen = ++deployPollGen;
    if (!expectedId) { setDeployBadge('unknown', '<i class="fas fa-info-circle"></i> Нет метки'); return; }
    try {
        const live = await fetchLiveDeployId();
        if (gen !== deployPollGen) return;
        if (live === expectedId) { setDeployBadge('live', '<i class="fas fa-check-circle"></i> Сайт обновлён'); return; }
        setDeployBadge('pending', '<i class="fas fa-spinner fa-spin"></i> Деплой...');
        if (singleCheck) return;
        for (let i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, 4000));
            if (gen !== deployPollGen) return;
            let live2 = null;
            try { live2 = await fetchLiveDeployId(); } catch {}
            if (gen !== deployPollGen) return;
            if (live2 === expectedId) {
                setDeployBadge('live', '<i class="fas fa-check-circle"></i> Сайт обновлён');
                showStatus('✓ Хостинг задеплоил изменения — сайт обновлён!', 'success');
                return;
            }
        }
        setDeployBadge('unknown', '<i class="fas fa-question-circle"></i> Долгий деплой (клик — проверить)');
    } catch (e) {
        if (gen !== deployPollGen) return;
        setDeployBadge('unknown', '<i class="fas fa-question-circle"></i> Не проверить');
    }
}

const b64d = b => {
    const clean = String(b).replace(/\s+/g, '');
    try { return new TextDecoder().decode(Uint8Array.from(atob(clean), c => c.charCodeAt(0))); }
    catch (e) { return atob(clean); }
};
const b64e = s => {
    const bytes = new TextEncoder().encode(s);
    let result = '';
    for (let i = 0; i < bytes.length; i += 8192) result += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(result);
};
const keepWs = (old, nv) => old.match(/^\s*/)[0] + nv.trim() + old.match(/\s*$/)[0];

function showStatus(msg, type = 'success') {
    const bar = $('statusBar');
    clearTimeout(statusTimer);
    bar.textContent = msg;
    bar.className = 'status-bar show ' + type;
    const timeout = type === 'error' ? 8000 : 4500;
    statusTimer = setTimeout(() => bar.classList.remove('show'), timeout);
}

function markUnsaved() { $('unsavedBadge').classList.toggle('show', Object.keys(pending).length > 0); }

async function gh(url, opts = {}) {
    const res = await fetch(url, {
        ...opts, cache: 'no-store',
        headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json', ...(opts.headers || {}) }
    });
    if (!res.ok) {
        const raw = await res.text();
        let msg = raw;
        try { msg = (JSON.parse(raw)).message || raw; } catch {}
        const err = new Error(`HTTP ${res.status}: ${msg}`);
        err.status = res.status; err.body = msg;
        throw err;
    }
    return res;
}

async function getFile(path) {
    const url = `${API}/contents/${encPath(path)}?ref=${encodeURIComponent(CMS_CONFIG.branch)}`;
    const d = await (await gh(url)).json();
    let text;
    if (d.encoding === 'base64' && d.content) text = b64d(d.content);
    else text = await (await gh(url, { headers: { 'Accept': 'application/vnd.github.raw+json' } })).text();
    return { text, sha: d.sha };
}

async function getSha(path) {
    try { return (await (await gh(`${API}/contents/${encPath(path)}?ref=${encodeURIComponent(CMS_CONFIG.branch)}`)).json()).sha; }
    catch (e) { if (e.status === 404) return null; throw e; }
}

async function putFile(path, b64, sha, message) {
    const body = { message: message || `Обновление ${path}`, content: b64, branch: CMS_CONFIG.branch };
    if (sha) body.sha = sha;
    return (await gh(`${API}/contents/${encPath(path)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    })).json();
}

function interpretError(status, body = '') {
    const b = String(body);
    if (status === 401) return { title: 'Токен недействителен или истёк', fix: 'Создайте новый токен и войдите заново.' };
    if (status === 403 || status === 429) {
        if (/rate limit/i.test(b)) return { title: 'Превышен лимит запросов GitHub API', fix: 'Подождите минуту и повторите.' };
        if (/scope|permission|not accessible/i.test(b)) return { title: 'У токена нет нужных прав', fix: 'Создайте НОВЫЙ токен с правами Contents: Read and write на этот репозиторий.' };
        return { title: 'Доступ запрещён', fix: 'Проверьте, что токен выдан на этот репозиторий и имеет право записи.' };
    }
    if (status === 404) return { title: 'Репозиторий или файл не найден', fix: `Проверьте имя файла и ветку "${CMS_CONFIG.branch}".` };
    if (status === 409) return { title: 'Конфликт версий (файл был изменён)', fix: 'Кто-то изменил файл в репозитории. Нажмите "Обновить" и примените правки заново.' };
    if (status === 422) return { title: 'Ошибка валидации', fix: 'Файл уже существует или данные некорректны. Попробуйте "Переподготовить".' };
    return { title: 'Ошибка запроса', fix: 'Проверьте интернет-соединение и повторите. Если не помогает — создайте новый токен.' };
}

function showErrorDetails(title, status, body, fix) {
    $('errorDetails').innerHTML = `<div class="error-details">
        <div class="err-title"><i class="fas fa-exclamation-triangle" style="color: #ff4444;"></i> ${esc(title)}</div>
        <div class="err-status">Код: ${esc(status)}</div>
        <div style="color: #888; font-size: 12px; margin-bottom: 8px;">${esc(body)}</div>
        <div class="err-fix"><i class="fas fa-check-circle"></i> ${esc(fix)}</div>
    </div>`;
}

async function checkToken() {
    const box = $('tokenInfo');
    box.textContent = 'Проверка токена...';
    $('errorDetails').innerHTML = '';
    try {
        const user = await (await gh('https://api.github.com/user')).json();
        const repo = await (await gh(API)).json();
        let hasIndex = true;
        try { await gh(`${API}/contents/index.html?ref=${encodeURIComponent(CMS_CONFIG.branch)}`); } catch { hasIndex = false; }
        const canPush = repo.permissions ? !!repo.permissions.push : null;
        box.innerHTML = `
            <div class="token-info"><span class="label"><i class="fas fa-check-circle" style="color: #00cc66;"></i> Пользователь:</span> ${esc(user.login)}</div>
            <div class="token-info" style="margin-top: 8px;"><span class="label"><i class="fas fa-check-circle" style="color: #00cc66;"></i> Репозиторий:</span> ${esc(repo.full_name)} (${repo.private ? 'приватный' : 'публичный'})</div>
            <div class="token-info" style="margin-top: 8px;"><span class="label"><i class="fas fa-${canPush === false ? 'times-circle' : 'check-circle'}" style="color: ${canPush === false ? '#ff4444' : '#00cc66'};"></i> Запись в репозиторий:</span> ${canPush === null ? 'нет данных' : canPush ? 'есть' : 'НЕТ — сохранение не удастся'}</div>
            <div class="token-info" style="margin-top: 8px;"><span class="label"><i class="fas fa-${hasIndex ? 'check-circle' : 'exclamation-circle'}" style="color: ${hasIndex ? '#00cc66' : '#ff9900'};"></i> index.html в ветке ${esc(CMS_CONFIG.branch)}:</span> ${hasIndex ? 'найден' : 'НЕ НАЙДЕН'}</div>
        `;
        if (canPush === false) showErrorDetails('Нет прав записи', 'WARNING', '', 'Выдайте токену право Contents: Read and write на этот репозиторий.');
        else if (!hasIndex) showErrorDetails('Файл index.html не найден', '404', `Ветка "${CMS_CONFIG.branch}" или файл не существует`, 'Создайте index.html в корне репозитория или проверьте ветку в config.js.');
        const ok = hasIndex && canPush !== false;
        showStatus(ok ? 'Токен валиден' : 'Есть проблемы — см. подробности', ok ? 'success' : 'error');
        return ok;
    } catch (e) {
        const i = interpretError(e.status, e.body);
        box.innerHTML = `<div class="token-info"><span class="label"><i class="fas fa-times-circle" style="color: #ff4444;"></i> Ошибка:</span> ${esc(e.message)}</div>`;
        showErrorDetails(i.title, e.status || 'сеть', e.body || e.message, i.fix);
        showStatus('✗ ' + i.title, 'error');
        return false;
    }
}

async function login() {
    const t = $('tokenInput').value.trim();
    const errEl = $('loginError');
    if (!t) {
        errEl.innerHTML = '<strong>Введите Personal Access Token</strong><br><small>Если токена нет — создайте его по ссылке ниже.</small>';
        errEl.classList.add('show');
        $('tokenInput').focus();
        return;
    }
    errEl.classList.remove('show');
    const btn = $('loginBtn');
    btn.disabled = true; btn.textContent = 'Проверка...';
    token = t;
    try {
        await gh('https://api.github.com/user');
        ss.set('gh_token', t);
        enterApp();
    } catch (e) {
        token = null;
        const i = interpretError(e.status, e.body);
        errEl.innerHTML = `<strong>${esc(i.title)}</strong><br><small>${esc(i.fix)}</small>`;
        errEl.classList.add('show');
        btn.disabled = false; btn.textContent = 'Войти';
    }
}

$('loginBtn').addEventListener('click', login);
$('tokenInput').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });

async function enterApp() {
    $('loginScreen').style.display = 'none';
    $('editorApp').classList.add('active');
    updatePageIndicator();
    try {
        let f;
        try { f = await getFile(currentFile); }
        catch (e) {
            if (e.status === 404 && currentFile !== 'index.html') {
                showStatus(`⚠ Файл "${currentFile}" не найден — переключаемся на index.html`, 'info');
                currentFile = 'index.html'; saveCurrentFile(); updatePageIndicator();
                f = await getFile(currentFile);
            } else throw e;
        }
        if (isAdminSelf(currentFile)) {
            showSetup();
            showErrorDetails('Админка лежит в корне сайта', 'CONFIG', 'Текущий файл совпадает с файлом самой админ-панели.', 'Переместите этот файл в папку admin/ (admin/index.html), а сайт оставьте в корневом index.html. Иначе редактор будет править сам себя.');
            return;
        }
        if (f.text.includes('data-edit="')) {
            repoDeployId = readDeployId(f.text);
            showEditor();
        } else { showSetup(); await checkToken(); }
    } catch (e) {
        showSetup();
        if (e.status === 404) showErrorDetails('Файл не найден', 404, `В репозитории ${CMS_CONFIG.owner}/${CMS_CONFIG.repo} ветка ${CMS_CONFIG.branch}`, 'Проверьте имя файла.');
        else if (e.status === 401 || e.status === 403) await checkToken();
        else { const i = interpretError(e.status, e.body); showErrorDetails(i.title, e.status || 'unknown', e.body || e.message, i.fix); }
    }
}

if (token) enterApp().catch(err => console.error('[enterApp]', err));

function logout() {
    if (Object.keys(pending).length && !confirm('Есть несохранённые изменения. Выйти?')) return;
    ss.del('gh_token');
    ls.del('cms_currentFile');
    pending = {};
    location.reload();
}

function showSetup() {
    $('setupScreen').classList.add('active');
    $('iframeWrapper').style.display = 'none';
    $('hintBanner').style.display = 'none';
    $('prepareBtn').disabled = false;
    $('prepareBtn').innerHTML = '<i class="fas fa-download"></i> Подготовить страницу';
    $('setupTitle').textContent = 'Подготовка ' + currentFile;
}

function showEditor() {
    $('setupScreen').classList.remove('active');
    $('iframeWrapper').style.display = 'block';
    $('hintBanner').style.display = 'block';
    loadSite();
}

function buildPreviewHtml(text) {
    const d = new DOMParser().parseFromString(text, 'text/html');
    d.querySelectorAll('meta[http-equiv="refresh" i]').forEach(n => n.remove());
    d.querySelectorAll('base').forEach(b => b.remove());
    const fixStyle = d.createElement('style');
    fixStyle.textContent = `
        .animate-on-scroll { opacity: 1 !important; transform: none !important; }
        .fade-in, .fade-in-up, .fade-in-down { opacity: 1 !important; transform: none !important; }
        [data-aos], [data-scroll], [data-scroll-reveal] { opacity: 1 !important; transform: none !important; }
        .hidden-on-load, .invisible { opacity: 1 !important; visibility: visible !important; }
        /* Режим админки: раскрываем все FAQ, чтобы можно было кликнуть и редактировать ответы */
        .faq-answer { max-height: none !important; padding-bottom: 25px !important; overflow: visible !important; }
        .faq-question i { transform: rotate(180deg) !important; }
    `;
    d.head.appendChild(fixStyle);
    const base = d.createElement('base');
    base.setAttribute('href', pageUrl().href);
    d.head.insertBefore(base, d.head.firstChild);
    return '<!DOCTYPE html>\n' + d.documentElement.outerHTML;
}

async function loadSite(skipVerify = false) {
    viewModeUrl = null;
    updatePageIndicator();
    const ifr = $('siteIframe');
    const loader = $('iframeLoader');
    const status = $('loaderStatus');
    loader.classList.remove('hidden');
    ifr.setAttribute('sandbox', PREVIEW_SANDBOX);
    status.textContent = 'Загрузка ' + currentFile + ' из GitHub...';
    try {
        const f = await getFile(currentFile);
        status.textContent = 'Подготовка превью...';
        repoDeployId = readDeployId(f.text);
        const html = buildPreviewHtml(f.text);
        ifr.onload = () => {
            hookIframe();
            loader.classList.add('hidden');
            if (!skipVerify) verifyDeploy(repoDeployId, true);
        };
        ifr.srcdoc = html;
    } catch (e) {
        status.textContent = 'Ошибка: ' + e.message;
        setTimeout(() => {
            ifr.removeAttribute('srcdoc');
            ifr.onload = () => { hookIframe(); loader.classList.add('hidden'); };
            ifr.src = pageUrl().href + '?t=' + Date.now();
        }, 1000);
    }
}

function reloadPreview() {
    if (Object.keys(pending).length) {
        if (!confirm('Несохранённые правки в превью пропадут. Обновить?')) return;
        pending = {}; markUnsaved();
    }
    loadSite();
    showStatus('Обновляем превью...', 'info');
}

function isInternalPage(href) {
    if (href === undefined || href === null) return false;
    if (href.trim().startsWith('#')) return false;
    if (href === '' || href === '/' || href === './') return true;
    const clean = href.split(/[?#]/)[0];
    if (/^(tel:|mailto:|javascript:|data:)/i.test(clean)) return false;
    if (!/^(https?:|\/\/)/i.test(clean)) {
        if (clean === '' || clean === '.') return true;
        if (clean.endsWith('/')) return true;
        if (clean.startsWith('/') && clean.replace(/\/+$/, '') === siteBasePathNoSlash()) return true;
        return /\.html?$/i.test(clean);
    }
    try {
        const url = new URL(clean.startsWith('//') ? 'https:' + clean : clean);
        const base = new URL(siteBaseUrl);
        if (url.hostname !== base.hostname) return false;
        const normalizedUrlPath = url.pathname.replace(/\/+$/, '');
        const normalizedBasePath = base.pathname.replace(/\/+$/, '');
        if (normalizedUrlPath === normalizedBasePath) return true;
        if (normalizedBasePath && !url.pathname.startsWith(normalizedBasePath + '/')) return false;
        return /\.html?$/i.test(url.pathname);
    } catch { return false; }
}

function normalizePagePath(href) {
    if (href === '' || href === '/' || href === './') return 'index.html';
    let p = href.split(/[?#]/)[0];
    if (/^(https?:|\/\/)/i.test(p)) {
        try {
            const u = new URL(p.startsWith('//') ? 'https:' + p : p);
            const basePathNoSlash = siteBasePathNoSlash();
            const up = u.pathname.replace(/\/+$/, '');
            if (up === basePathNoSlash) return 'index.html';
            p = u.pathname;
        } catch {}
        try { p = decodeURIComponent(p); } catch {}
        if (siteBasePath !== '/' && p.startsWith(siteBasePath)) p = p.slice(siteBasePath.length);
        p = p.replace(/^\/+/, '');
    } else {
        try { p = decodeURIComponent(p); } catch {}
        if (p.startsWith('/')) {
            const basePathNoSlash = siteBasePathNoSlash();
            const pp = p.replace(/\/+$/, '');
            if (pp === basePathNoSlash) return 'index.html';
            if (siteBasePath !== '/' && p.startsWith(siteBasePath)) p = p.slice(siteBasePath.length);
            p = p.replace(/^\/+/, '');
        } else {
            if (p === '' || p === '.') return 'index.html';
            if (p.endsWith('/')) {
                const resolved = resolveRepoPath(p + 'index.html');
                return resolved || 'index.html';
            }
            const r = resolveRepoPath(p);
            p = r || '';
        }
    }
    p = p.replace(/^(\.\/)+/, '');
    if (!p || p === '.') return 'index.html';
    if (p.split('/').some(s => s === '..')) return '';
    return p;
}

async function prepareCurrentFile(logContainer = null) {
    const btn = $('prepareBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Подготовка...'; }
    const fileBeingPrepared = currentFile;
    $('errorDetails').innerHTML = '';
    const li = (msg, type = '') => {
        if (logContainer) {
            const div = document.createElement('div');
            div.className = 'log-item ' + type;
            div.textContent = (type === 'done' ? '✓ ' : type === 'error' ? '✗ ' : '→ ') + msg;
            logContainer.appendChild(div);
            logContainer.scrollTop = logContainer.scrollHeight;
        }
    };
    try {
        if (isAdminSelf(fileBeingPrepared)) {
            li('⚠ Операция отменена: это файл самой админ-панели', 'error');
            showStatus('Админку нельзя редактировать через саму себя. Переместите её в папку admin/.', 'error');
            return false;
        }
        li('Загрузка ' + fileBeingPrepared + ' из репозитория...', 'working');
        const f = await getFile(fileBeingPrepared);
        if (!f.text.trim()) throw new Error(fileBeingPrepared + ' пуст или не прочитан');
        li(`${fileBeingPrepared} загружен (${(f.text.length / 1024).toFixed(1)} КБ)`, 'done');
        if (f.text.includes('data-edit="') || f.text.includes('data-img=')) {
            li('Обнаружены старые метки — очищаем...', 'working');
            const cleaned = cleanHtmlMarks(f.text);
            f.text = cleaned.html;
            li(`Удалено: ${cleaned.removedEdit} text-меток и ${cleaned.removedImg} img-меток`, 'done');
        }
        li('Анализ контента и расстановка меток...', 'working');
        const r = processHtml(f.text);
        li(`Найдено ${r.textCount} текстов и ${r.imgCount} картинок`, 'done');
        li('Сохранение подготовленного ' + fileBeingPrepared + '...', 'working');
        const deployId = newDeployId();
        const stamped = stampDeployId(r.html, deployId);
        await putFile(fileBeingPrepared, b64e(stamped), f.sha, `Подготовка ${fileBeingPrepared} к редактированию`);
        repoDeployId = deployId;
        li(fileBeingPrepared + ' обновлён в репозитории', 'done');
        li('Подготовка завершена!', 'done');
        return true;
    } catch (e) {
        li('Ошибка: ' + e.message, 'error');
        const i = interpretError(e.status, e.body);
        showErrorDetails(i.title, e.status || 'ошибка', e.body || e.message, i.fix);
        showStatus(`✗ ${i.title}`, 'error');
        return false;
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-download"></i> Подготовить страницу'; }
    }
}

async function prepareSite() {
    const log = $('progressLog');
    log.style.display = 'block'; log.innerHTML = '';
    $('errorDetails').innerHTML = '';
    const ok = await prepareCurrentFile(log);
    if (ok) setTimeout(() => { showStatus('Страница подготовлена! Открываем редактор...'); setTimeout(showEditor, 500); }, 300);
}

async function navigateTo(href) {
    const cleanPath = normalizePagePath(href);
    if (!cleanPath) { showStatus('Не удалось определить страницу по ссылке: ' + href, 'error'); return; }
    if (isAdminSelf(cleanPath)) {
        showStatus('⚠ Это файл самой админ-панели — редактировать его нельзя.', 'error');
        return;
    }
    if (cleanPath === currentFile && !viewModeUrl) { reloadPreview(); return; }
    if (Object.keys(pending).length) {
        if (!confirm('Есть несохранённые правки. При переходе они будут потеряны. Продолжить?')) return;
        pending = {}; markUnsaved();
    }
    const prevFile = currentFile;
    const prevView = viewModeUrl;
    currentFile = cleanPath;
    saveCurrentFile();
    viewModeUrl = null;
    updatePageIndicator();
    showStatus('Открываю ' + cleanPath + '...', 'info');
    try {
        const f = await getFile(currentFile);
        if (f.text.includes('data-edit="')) {
            repoDeployId = readDeployId(f.text);
            showEditor();
            showStatus('✓ ' + cleanPath + ' открыта для редактирования', 'success');
        } else {
            showSetup();
            $('setupTitle').textContent = 'Подготовка ' + cleanPath;
            $('errorDetails').innerHTML = '';
            const log = $('progressLog');
            log.style.display = 'block'; log.innerHTML = '';
            showStatus('Страница не подготовлена — подготавливаю ' + cleanPath + '...', 'info');
            const ok = await prepareCurrentFile(log);
            if (ok) {
                showEditor();
                showStatus('✓ Страница ' + cleanPath + ' готова к редактированию!', 'success');
            } else {
                currentFile = prevFile;
                viewModeUrl = prevView;
                saveCurrentFile();
                updatePageIndicator();
                $('setupScreen').classList.remove('active');
                showEditor();
            }
        }
    } catch (e) {
        const i = interpretError(e.status, e.body);
        showStatus('✗ Не удалось открыть ' + cleanPath + ': ' + i.title, 'error');
        currentFile = prevFile;
        viewModeUrl = prevView;
        saveCurrentFile();
        updatePageIndicator();
        $('setupScreen').classList.remove('active');
        showEditor();
    }
}

function openExternalInIframe(url) {
    viewModeUrl = url;
    updatePageIndicator();
    const ifr = $('siteIframe');
    $('iframeLoader').classList.remove('hidden');
    $('loaderStatus').textContent = 'Открываю ссылку в режиме просмотра...';
    ifr.setAttribute('sandbox', VIEW_SANDBOX);
    ifr.removeAttribute('srcdoc');
    ifr.onload = () => { $('iframeLoader').classList.add('hidden'); };
    ifr.src = url;
    showStatus('Режим просмотра: редактирование недоступно. Нажмите «Домой» для возврата.', 'info');
}

function goHome() {
    if (currentFile === 'index.html' && !viewModeUrl) { reloadPreview(); return; }
    navigateTo('index.html');
}

function openLiveSite() { window.open(viewModeUrl ? viewModeUrl : pageUrl().href, '_blank', 'noopener'); }

function hookIframe() {
    let d;
    try { d = $('siteIframe').contentDocument; } catch { d = null; }
    if (!d || !d.head) {
        showStatus('Нет доступа к превью (sandbox)', 'error');
        return;
    }
    if (d.__cmsAdminHooked) return;
    d.__cmsAdminHooked = true;

    const st = d.createElement('style');
    st.textContent = `[data-edit]:hover, [data-img]:hover { outline: 2px dashed #F40009; outline-offset: 2px; cursor: pointer; }`;
    d.head.appendChild(st);

    function hideLoadedPlaceholders() {
        d.querySelectorAll('.placeholder-label').forEach(ph => {
            const holder = ph.parentElement;
            if (!holder) return;
            const img = holder.querySelector('img');
            if (!img) return;
            const hide = () => {
                if (img.complete && img.naturalWidth > 0) ph.style.display = 'none';
            };
            if (img.complete) hide();
            img.addEventListener('load', hide);
            img.addEventListener('error', () => { if (ph.style.display !== 'none') ph.style.display = ''; });
        });
    }
    hideLoadedPlaceholders();

    const handleModifierOpen = ev => {
        const linkEl = ev.target.closest && ev.target.closest('a[href]');
        if (!linkEl) return false;
        ev.preventDefault(); ev.stopPropagation();
        openSafe((linkEl.getAttribute('href') || '').trim());
        return true;
    };

    d.addEventListener('auxclick', ev => { if (ev.button === 1) handleModifierOpen(ev); }, true);

    d.addEventListener('click', ev => {
        if (ev.altKey) {
            const linkEl = ev.target.closest && ev.target.closest('a[href]');
            if (linkEl) {
                ev.preventDefault();
                ev.stopPropagation();
                const href = (linkEl.getAttribute('href') || '').trim();
                if (href === '') return;
                if (/^(tel:|mailto:)/i.test(href)) { openSafe(href); return; }
                if (href.startsWith('#')) {
                    const id = href.slice(1);
                    const target = id ? (d.getElementById(id) || d.querySelector(`[name="${CSS.escape(id)}"]`)) : null;
                    if (target) target.scrollIntoView({ behavior: 'smooth' });
                    return;
                }
                if (isInternalPage(href)) { navigateTo(href); return; }
                const abs = safeAbs(href);
                if (abs && /^https?:/i.test(abs)) openExternalInIframe(abs);
                return;
            }
            ev.preventDefault();
            return;
        }
        if (ev.ctrlKey || ev.metaKey) {
            if (handleModifierOpen(ev)) return;
        }
        const textEl = ev.target.closest && ev.target.closest('[data-edit]');
        if (textEl) { ev.preventDefault(); ev.stopPropagation(); openText(textEl.getAttribute('data-edit'), textEl.textContent); return; }
        const imgEl = ev.target.closest && ev.target.closest('[data-img]');
        if (imgEl) {
            ev.preventDefault(); ev.stopPropagation();
            const path = imgEl.getAttribute('data-img');
            const imgId = imgEl.getAttribute('data-img-id') || '';
            const actualImg = imgEl.tagName === 'IMG' ? imgEl : imgEl.querySelector('img');
            openImage(path, actualImg ? (actualImg.currentSrc || actualImg.src) : '', imgId);
            return;
        }
        const linkEl = ev.target.closest && ev.target.closest('a[href]');
        if (linkEl) ev.preventDefault();
    }, true);

    d.addEventListener('keydown', ev => {
        if (ev.key !== 'Escape') return;
        if ($('editPanel').classList.contains('active')) { closePanel(); }
    }, true);
}

document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if ($('editPanel').classList.contains('active')) { closePanel(); }
});

function syncHref(el, newValue) {
    const link = el.closest('a[href]');
    if (!link || link.hasAttribute('data-cms-link')) return;
    const href = link.getAttribute('href') || '';
    const v = newValue.trim();
    if (/^tel:/i.test(href)) {
        const clean = v.replace(/[^\d+]/g, '');
        if (clean.length >= 7) link.setAttribute('href', 'tel:' + clean);
        return;
    }
    if (/^mailto:/i.test(href)) {
        if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) link.setAttribute('href', 'mailto:' + v);
        return;
    }
    let host = '';
    try { host = new URL(href, 'https://x.invalid').hostname.replace(/^www\./, '').toLowerCase(); } catch { return; }
    if (host === 't.me' || host === 'telegram.me') {
        const u = v.replace(/^@/, '').replace(/^https?:\/\/(t\.me|telegram\.me)\//, '');
        if (/^[a-zA-Z0-9_]{3,}$/.test(u)) link.setAttribute('href', 'https://t.me/' + u);
    } else if (host === 'wa.me') {
        const clean = v.replace(/[^\d]/g, '');
        if (clean.length >= 7) link.setAttribute('href', 'https://wa.me/' + clean);
    } else if (host === 'vk.com') {
        const u = v.replace(/^@/, '').replace(/^https?:\/\/(www\.)?vk\.com\//, '');
        if (/^[a-zA-Z0-9_.]+$/.test(u)) link.setAttribute('href', 'https://vk.com/' + u);
    } else if (host === 'instagram.com') {
        const u = v.replace(/^@/, '').replace(/^https?:\/\/(www\.)?instagram\.com\//, '');
        if (/^[a-zA-Z0-9_.]+$/.test(u)) link.setAttribute('href', 'https://instagram.com/' + u);
    }
}

function findImgTargets(doc, key, path) {
    if (!doc) return [];
    if (key && /^img_\d+$/.test(key)) {
        const el = doc.querySelector(`[data-img-id="${CSS.escape(key)}"]`);
        return el ? [el] : [];
    }
    const lookupPath = path || key;
    if (!lookupPath) return [];
    return Array.from(doc.querySelectorAll(`[data-img="${CSS.escape(lookupPath)}"]`));
}

function readTextLink(key) {
    const dflt = { url: '', linkColor: 'inherit', linkTarget: '_blank' };
    let d = null;
    try { d = $('siteIframe').contentDocument; } catch {}
    if (!d) return dflt;
    const el = d.querySelector(`[data-edit="${CSS.escape(key)}"]`);
    if (!el) return dflt;
    const link = el.closest('a[data-cms-link]');
    if (!link) return dflt;
    const storedColor = link.getAttribute('data-link-color') || 'inherit';
    const target = link.getAttribute('target') || '_blank';
    return {
        url: link.getAttribute('href') || '',
        linkColor: LINK_COLORS[storedColor] !== undefined ? storedColor : 'inherit',
        linkTarget: target === '_self' ? '_self' : '_blank'
    };
}

function readImageLink(key, path) {
    let d = null;
    try { d = $('siteIframe').contentDocument; } catch {}
    if (!d) return { url: '', linkTarget: '_blank' };
    const targets = findImgTargets(d, key, path);
    if (!targets.length) return { url: '', linkTarget: '_blank' };
    const target = targets[0];
    let linkEl = target.tagName === 'A' ? target : (target.closest ? target.closest('a') : null);
    if (!linkEl && target.querySelector) {
        const inner = target.querySelector('img');
        linkEl = inner ? inner.closest('a') : null;
    }
    if (!linkEl) return { url: '', linkTarget: '_blank' };
    if (!linkEl.hasAttribute('data-cms-link')) return { url: '', linkTarget: '_blank' };
    const href = linkEl.getAttribute('href') || '';
    const targetAttr = linkEl.getAttribute('target') || '_blank';
    return { url: href, linkTarget: targetAttr === '_self' ? '_self' : '_blank' };
}

function applyLinkToText(doc, el, url, keepColor, linkColor, linkTarget) {
    if (!el) return;
    let link = el.closest ? el.closest('a') : null;
    if (url && url.trim()) {
        url = url.trim();
        if (!link) {
            link = doc.createElement('a');
            el.parentNode.insertBefore(link, el);
            link.appendChild(el);
        }
        link.setAttribute('data-cms-link', '1');
        link.setAttribute('href', url);
        link.setAttribute('target', linkTarget === '_self' ? '_self' : '_blank');
        if (linkTarget === '_blank') link.setAttribute('rel', 'noopener');
        else link.removeAttribute('rel');
        const colorKey = linkColor && LINK_COLORS[linkColor] !== undefined ? linkColor : 'inherit';
        link.setAttribute('data-link-color', colorKey);
        if (colorKey === 'inherit' || keepColor) {
            link.style.color = 'inherit';
            link.style.textDecoration = 'none';
            if (keepColor) link.setAttribute('data-keep-color', '1');
            else link.removeAttribute('data-keep-color');
        } else {
            link.removeAttribute('data-keep-color');
            link.style.color = LINK_COLORS[colorKey];
            link.style.textDecoration = 'underline';
        }
    } else if (link && link.hasAttribute('data-cms-link')) {
        link.parentNode.insertBefore(el, link);
        if (link.textContent.trim() === '' && !link.querySelector('img, [data-edit], [data-img]')) {
            link.parentNode.removeChild(link);
        } else {
            ['data-cms-link', 'data-keep-color', 'data-link-color', 'href', 'target', 'rel'].forEach(a => link.removeAttribute(a));
            link.style.color = '';
            link.style.textDecoration = '';
        }
    }
}

function applyLinkToImage(doc, target, url, linkTarget = '_blank') {
    if (!target) return;
    const isA = target.tagName === 'A';
    const findInner = () => {
        if (!target.querySelector) return null;
        const img = target.querySelector('img');
        const a = img ? img.closest('a') : null;
        return a && target.contains(a) ? a : null;
    };
    if (!url || !url.trim()) {
        const link = isA ? target : ((target.closest && target.closest('a')) || findInner());
        if (!link) return;
        if (link === target) {
            ['href', 'target', 'rel', 'data-cms-link'].forEach(a => link.removeAttribute(a));
            return;
        }
        while (link.firstChild) link.parentNode.insertBefore(link.firstChild, link);
        link.parentNode.removeChild(link);
        return;
    }
    url = url.trim();
    let link = isA ? target : ((target.closest && target.closest('a')) || findInner());
    if (!link) {
        const hasInnerA = target.querySelector && target.querySelector('a');
        const wrapNode = hasInnerA ? (target.querySelector('img') || target) : target;
        link = doc.createElement('a');
        wrapNode.parentNode.insertBefore(link, wrapNode);
        link.appendChild(wrapNode);
    }
    link.setAttribute('data-cms-link', '1');
    link.setAttribute('href', url);
    link.setAttribute('target', linkTarget === '_self' ? '_self' : '_blank');
    if (linkTarget === '_blank') link.setAttribute('rel', 'noopener');
    else link.removeAttribute('rel');
}

function cleanHtmlMarks(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const beforeEdit = doc.querySelectorAll('[data-edit]').length;
    const beforeImg = doc.querySelectorAll('[data-img]').length;
    doc.querySelectorAll('[data-edit]').forEach(el => {
        const parent = el.parentNode;
        if (!parent) return;
        const pure = el.tagName === 'SPAN' && el.attributes.length === 1;
        if (pure) {
            while (el.firstChild) parent.insertBefore(el.firstChild, el);
            parent.removeChild(el);
        } else el.removeAttribute('data-edit');
    });
    doc.querySelectorAll('[data-img], [data-img-id]').forEach(el => {
        el.removeAttribute('data-img');
        el.removeAttribute('data-img-id');
    });
    doc.body.normalize();
    return { html: '<!DOCTYPE html>\n' + doc.documentElement.outerHTML, removedEdit: beforeEdit, removedImg: beforeImg };
}

function processHtml(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    let textCounter = 0;
    doc.querySelectorAll('[data-edit^="auto_"]').forEach(el => {
        const m = el.getAttribute('data-edit').match(/^auto_(\d+)$/);
        if (m) {
            const n = parseInt(m[1], 10);
            if (n > textCounter) textCounter = n;
        }
    });
    const SKIP_TAGS = new Set(['script', 'style', 'title', 'meta', 'noscript', 'input', 'textarea', 'select', 'option', 'head', 'link', 'template']);
    const extra = (CMS_CONFIG.extraEditableSelectors || []).concat('[data-editable]').join(', ');
    const forced = new Set();
    try { doc.querySelectorAll(extra).forEach(el => forced.add(el)); } catch {}

    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            const parent = node.parentElement;
            if (!parent) return NodeFilter.FILTER_REJECT;
            if (parent.namespaceURI !== XHTML_NS) return NodeFilter.FILTER_REJECT;
            if (parent.closest('svg, math, script, style, textarea, select, noscript, template')) return NodeFilter.FILTER_REJECT;
            if (!forced.has(parent) && SKIP_TAGS.has(parent.tagName.toLowerCase())) return NodeFilter.FILTER_REJECT;
            if (parent.hasAttribute('data-edit')) return NodeFilter.FILTER_REJECT;
            const text = node.textContent;
            if (!text || !text.trim()) return NodeFilter.FILTER_REJECT;
            return /[\p{L}\p{N}]/u.test(text) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
    });
    const nodesToProcess = [];
    let node;
    while (node = walker.nextNode()) nodesToProcess.push(node);
    let textCount = 0;
    nodesToProcess.forEach(textNode => {
        const span = doc.createElement('span');
        span.setAttribute('data-edit', `auto_${++textCounter}`);
        span.textContent = textNode.textContent;
        textNode.parentElement.replaceChild(span, textNode);
        textCount++;
    });
    doc.querySelectorAll('[data-editable]').forEach(el => el.removeAttribute('data-editable'));

    const CORE_IMAGE_WRAPPERS = [
        '.img-wrapper', '.gallery-item', '.team-photo',
        '.about-img-wrapper', '.hero-img-wrapper', '.product-image',
        '.portfolio-card', '.space-card', '.portfolio-item'
    ];
    const wrapperSelector = [...CORE_IMAGE_WRAPPERS, ...(CMS_CONFIG.imageWrappers || [])].join(', ');
    let imgCount = 0, imgIdCounter = 0;
    doc.querySelectorAll('img').forEach(img => {
        if (img.hasAttribute('data-img')) return;
        const src = img.getAttribute('src');
        if (!src || /^(data:|blob:|https?:|\/\/)/i.test(src)) return;
        const path = resolveRepoPath(src);
        if (!path) return;
        let wrapper = null;
        try { wrapper = img.closest(wrapperSelector); } catch {}
        if (wrapper && wrapper.hasAttribute('data-img')) return;
        const imgId = 'img_' + (++imgIdCounter);
        const holder = wrapper || img;
        holder.setAttribute('data-img', path);
        holder.setAttribute('data-img-id', imgId);
        imgCount++;
    });
    return { html: '<!DOCTYPE html>\n' + doc.documentElement.outerHTML, textCount, imgCount };
}

async function cleanMarks() {
    if (Object.keys(pending).length > 0) {
        if (!confirm('У вас есть несохранённые правки. Они будут потеряны при очистке. Продолжить?')) return;
        pending = {}; markUnsaved();
    }
    if (!confirm('Удалить ВСЕ метки редактирования (data-edit, data-img, data-img-id) из ' + currentFile + '?\n\nПравки текстов и ручные ссылки СОХРАНЯТСЯ.\nПосле очистки нужно снова нажать «Подготовить страницу».\n\nПродолжить?')) return;
    const btn = $('cleanBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Очищаю...';
    try {
        showStatus('Загружаю ' + currentFile + '...', 'info');
        const f = await getFile(currentFile);
        if (!f.text.includes('data-edit="') && !f.text.includes('data-img=')) {
            showStatus('Меток в файле нет — очищать нечего', 'info');
            return;
        }
        showStatus('Удаляю метки...', 'info');
        const result = cleanHtmlMarks(f.text);
        const deployId = newDeployId();
        const stamped = stampDeployId(result.html, deployId);
        showStatus('Сохраняю очищенный файл...', 'info');
        await putFile(currentFile, b64e(stamped), f.sha, `Очистка меток редактирования в ${currentFile}`);
        repoDeployId = deployId;
        showStatus(`✓ Очищено: ${result.removedEdit} text-меток и ${result.removedImg} img-меток.`, 'success');
        setTimeout(() => { showSetup(); $('setupTitle').textContent = 'Страница очищена — готова к подготовке'; }, 1500);
    } catch (e) {
        const i = interpretError(e.status, e.body);
        showStatus(`✗ Ошибка: ${i.title}`, 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-broom"></i> Очистить метки';
    }
}

function openPanel(title, key) {
    lastFocus = document.activeElement;
    $('editTitle').textContent = title;
    $('editKey').textContent = key;
    $('editPanel').classList.add('active');
}

function openText(key, value) {
    editKind = 'text'; editKey = key;
    openPanel('Редактирование текста', key);
    const linkData = readTextLink(key);
    editOrigText = linkData;
    $('editPanelContent').innerHTML = `
        <textarea id="editTextArea" aria-label="Текст"></textarea>
        <div class="link-section">
            <label class="field-label" for="editLink"><i class="fas fa-link" style="color:#F40009;"></i> Ссылка при клике на текст (необязательно)</label>
            <input type="url" id="editLink" placeholder="https://..." autocomplete="off">
            <div class="link-hint">Оставьте поле пустым, чтобы убрать ссылку с текста.</div>
        </div>
        <div class="link-option">
            <span class="field-label"><i class="fas fa-palette" style="color:#CD853F;"></i> Цвет ссылки</span>
            <div class="option-group">
                <label class="radio-label"><input type="radio" name="linkColor" value="inherit"><span class="color-preview inherit">Текущий</span></label>
                <label class="radio-label"><input type="radio" name="linkColor" value="brown"><span class="color-preview brown">Коричневый</span></label>
                <label class="radio-label"><input type="radio" name="linkColor" value="lightbrown"><span class="color-preview lightbrown">Светло-коричневый</span></label>
            </div>
        </div>
        <div class="link-option">
            <span class="field-label"><i class="fas fa-external-link-alt" style="color:#c9a961;"></i> Открывать ссылку</span>
            <div class="option-group">
                <label class="radio-label"><input type="radio" name="linkTarget" value="_blank"><span class="target-label">В новой вкладке</span></label>
                <label class="radio-label"><input type="radio" name="linkTarget" value="_self"><span class="target-label">В том же окне</span></label>
            </div>
        </div>
    `;
    const ta = $('editTextArea');
    ta.value = pending['t:' + key] ? pending['t:' + key].value : value.trim();
    $('editLink').value = linkData.url;
    const colorRadio = document.querySelector(`input[name="linkColor"][value="${linkData.linkColor}"]`) || document.querySelector('input[name="linkColor"][value="inherit"]');
    if (colorRadio) colorRadio.checked = true;
    const targetRadio = document.querySelector(`input[name="linkTarget"][value="${linkData.linkTarget}"]`) || document.querySelector('input[name="linkTarget"][value="_blank"]');
    if (targetRadio) targetRadio.checked = true;
    setTimeout(() => ta.focus(), 100);
}

function openImage(path, src, imgId) {
    editKind = 'image';
    editKey = imgId || path;
    editImagePath = path;
    pendingImg = null;
    openPanel('Замена изображения', path);
    const imgLinkData = readImageLink(editKey, path);
    editOrigImg = imgLinkData;

    const currentExt = (path.split('.').pop() || '').toLowerCase();
    const extDisplay = currentExt ? `<code style="background:#2a2a2a;padding:2px 6px;border-radius:3px;font-size:11px;">.${esc(currentExt)}</code>` : '';

    $('editPanelContent').innerHTML = `
        <div style="margin-bottom: 16px;">
            <div style="color: #888; font-size: 13px; margin-bottom: 8px;">Текущее фото ${extDisplay}:</div>
            <img id="curImg" alt="" style="max-width: 100%; max-height: 180px; border-radius: 8px;">
        </div>
        <label class="file-upload">
            <i class="fas fa-cloud-upload-alt"></i>
            <div class="upload-text"><strong>Выберите новое изображение</strong><br><small>Поддерживаются: JPG, PNG, WebP, GIF, SVG. Максимум 2 МБ. Файл заменит <code style="background:#2a2a2a;padding:1px 5px;border-radius:3px;">${esc(path)}</code>.</small></div>
            <input type="file" id="imageFileInput" accept="image/*">
        </label>
        <div id="imagePreview" style="margin-top: 12px;"></div>
        <div class="link-section">
            <label class="field-label" for="imgLink"><i class="fas fa-link" style="color:#F40009;"></i> Ссылка при клике на фото (необязательно)</label>
            <input type="url" id="imgLink" placeholder="https://..." autocomplete="off">
            <div class="link-hint">Куда переходить при клике по картинке. Оставьте пустым, чтобы убрать ссылку.</div>
        </div>
        <div class="link-option">
            <span class="field-label"><i class="fas fa-external-link-alt" style="color:#c9a961;"></i> Открывать ссылку</span>
            <div class="option-group">
                <label class="radio-label"><input type="radio" name="imgLinkTarget" value="_blank"><span class="target-label">В новой вкладке</span></label>
                <label class="radio-label"><input type="radio" name="imgLinkTarget" value="_self"><span class="target-label">В том же окне</span></label>
            </div>
        </div>
    `;
    if (src) $('curImg').src = src;
    $('imgLink').value = imgLinkData.url;
    const r = document.querySelector(`input[name="imgLinkTarget"][value="${imgLinkData.linkTarget}"]`) || document.querySelector('input[name="imgLinkTarget"][value="_blank"]');
    if (r) r.checked = true;

    const IMAGE_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml', 'image/bmp', 'image/x-icon'];

    $('imageFileInput').addEventListener('change', e => {
        const file = e.target.files[0];
        if (!file) return;

        if (!IMAGE_TYPES.includes(file.type) && !file.type.startsWith('image/')) {
            e.target.value = '';
            return showStatus('Файл должен быть изображением (JPG, PNG, WebP, GIF, SVG)', 'error');
        }

        if (file.size > 2 * 1024 * 1024) {
            e.target.value = '';
            return showStatus('Файл слишком большой (максимум 2 МБ)', 'error');
        }

        const fileExt = (file.name.split('.').pop() || '').toLowerCase();
        const ALLOWED_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg', 'bmp', 'ico'];
        if (!ALLOWED_EXTS.includes(fileExt)) {
            e.target.value = '';
            return showStatus('Неподдерживаемое расширение файла: .' + fileExt, 'error');
        }

        if ((currentExt === 'svg') !== (fileExt === 'svg')) {
            e.target.value = '';
            return showStatus('SVG заменяется только на SVG, растровое фото — только на растровое (JPG/PNG/WebP)', 'error');
        }

        const rd = new FileReader();
        rd.onload = ev => {
            pendingImg = ev.target.result;
            $('imagePreview').innerHTML = `<div style="color: #00cc66; font-size: 13px;"><i class="fas fa-check-circle"></i> Файл: <strong>${esc(file.name)}</strong> (${(file.size / 1024).toFixed(0)} КБ) — готов к загрузке</div>`;
        };
        rd.readAsDataURL(file);
    });
}

function applyEdit() {
    let d = null;
    try { d = $('siteIframe').contentDocument; } catch {}

    if (editKind === 'text') {
        const v = $('editTextArea').value;
        const linkUrl = $('editLink').value.trim();
        if (!validLinkUrl(linkUrl)) return showStatus('Недопустимая ссылка (разрешены http, https, tel, mailto, #)', 'error');
        const colorEl = document.querySelector('input[name="linkColor"]:checked');
        const targetEl = document.querySelector('input[name="linkTarget"]:checked');
        const linkColor = colorEl ? colorEl.value : 'inherit';
        const linkTarget = targetEl ? targetEl.value : '_blank';
        const keepColor = linkColor === 'inherit';
        const o = editOrigText || { url: '', linkColor: 'inherit', linkTarget: '_blank' };
        const prev = pending['t:' + editKey];
        const changed = linkUrl !== o.url || (!!linkUrl && (linkColor !== o.linkColor || linkTarget !== o.linkTarget));
        const linkChanged = changed || !!(prev && prev.linkChanged);
        pending['t:' + editKey] = {
            type: 'text', value: v, link: linkUrl, keepColor, linkColor, linkTarget, linkChanged
        };
        if (d) {
            const el = d.querySelector(`[data-edit="${CSS.escape(editKey)}"]`);
            if (el) {
                el.textContent = keepWs(el.textContent, v);
                if (linkChanged) applyLinkToText(d, el, linkUrl, keepColor, linkColor, linkTarget);
                if (!linkUrl) syncHref(el, v);
            }
        }
        showStatus((linkUrl ? 'Изменения и ссылка применены.' : 'Изменения применены.') + ' Сохраните в GitHub.');
    } else if (editKind === 'image') {
        const imgLinkUrl = $('imgLink').value.trim();
        if (!validLinkUrl(imgLinkUrl)) return showStatus('Недопустимая ссылка (разрешены http, https, tel, mailto, #)', 'error');
        const imgTargetEl = document.querySelector('input[name="imgLinkTarget"]:checked');
        const imgLinkTarget = imgTargetEl ? imgTargetEl.value : '_blank';
        const o = editOrigImg || { url: '', linkTarget: '_blank' };
        const prev = pending['i:' + editKey];
        const changed = imgLinkUrl !== o.url || (!!imgLinkUrl && imgLinkTarget !== o.linkTarget);
        const linkChanged = changed || !!(prev && prev.linkChanged);
        const data = pendingImg || (prev && prev.data) || null;
        if (!data && !linkChanged) return showStatus('Выберите файл или измените ссылку', 'error');
        const path = editImagePath || editKey;
        pending['i:' + editKey] = { type: 'image', data, path, key: editKey, link: imgLinkUrl, linkTarget: imgLinkTarget, linkChanged };
        if (d) {
            findImgTargets(d, editKey, path).forEach(target => {
                if (pendingImg) {
                    const img = target.tagName === 'IMG' ? target : target.querySelector('img');
                    if (img) {
                        img.removeAttribute('srcset');
                        const pic = img.closest('picture');
                        if (pic) pic.querySelectorAll('source').forEach(s => s.removeAttribute('srcset'));
                        img.src = pendingImg;
                    }
                }
                if (linkChanged) applyLinkToImage(d, target, imgLinkUrl, imgLinkTarget);
            });
        }
        if (pendingImg && changed && imgLinkUrl) showStatus('Фото и ссылка применены.');
        else if (changed && imgLinkUrl) showStatus('Ссылка на фото применена.');
        else if (pendingImg) showStatus('Фото изменено.');
        else showStatus('Ссылка с фото убрана.');
    }
    markUnsaved();
    closePanel();
}

function closePanel() {
    $('editPanel').classList.remove('active');
    editKind = editKey = editImagePath = pendingImg = editOrigText = editOrigImg = null;
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch {} }
    lastFocus = null;
}

async function saveAll() {
    const keys = Object.keys(pending);
    if (!keys.length) return showStatus('Нет изменений для сохранения', 'info');
    const btn = $('saveBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Сохранение...';
    const done = [], failed = [];
    try {
        const texts = keys.filter(k => pending[k].type === 'text');
        const images = keys.filter(k => pending[k].type === 'image');
        const imagesWithData = images.filter(k => pending[k].data);
        const imagesWithLinks = images.filter(k => pending[k].linkChanged);

        for (const k of imagesWithData) {
            const { path, data } = pending[k];
            try {
                await putFile(path, data.split(',')[1], await getSha(path), `Обновление изображения ${path}`);
                if (!done.includes(k)) done.push(k);
            } catch (e) {
                console.error('[saveAll:image]', k, e.status, e.body, e);
                if (!failed.includes(k)) failed.push(k);
            }
        }

        const f = await getFile(currentFile);
        const doc = new DOMParser().parseFromString(f.text, 'text/html');

        for (const k of texts) {
            const p = pending[k];
            const el = doc.querySelector(`[data-edit="${CSS.escape(k.slice(2))}"]`);
            if (!el) { if (!failed.includes(k)) failed.push(k); continue; }
            el.textContent = keepWs(el.textContent, p.value);
            if (p.linkChanged) applyLinkToText(doc, el, p.link || '', p.keepColor || false, p.linkColor || 'inherit', p.linkTarget || '_blank');
            if (!p.link) syncHref(el, p.value);
            if (!done.includes(k)) done.push(k);
        }

        for (const k of imagesWithLinks) {
            const { path, link, key, linkTarget } = pending[k];
            const targets = findImgTargets(doc, key || k.slice(2), path);
            if (targets.length) {
                targets.forEach(t => applyLinkToImage(doc, t, link, linkTarget || '_blank'));
                if (!done.includes(k)) done.push(k);
            } else if (!failed.includes(k)) failed.push(k);
        }

        const deployId = newDeployId();
        const stamped = stampDeployId('<!DOCTYPE html>\n' + doc.documentElement.outerHTML, deployId);
        await putFile(currentFile, b64e(stamped), f.sha, `Редактирование ${currentFile}`);
        repoDeployId = deployId;

        done.filter(k => !failed.includes(k)).forEach(k => delete pending[k]);
        markUnsaved();
        if (failed.length) {
            const successCount = done.filter(k => !failed.includes(k)).length;
            showStatus(`Сохранено: ${successCount}. Не сохранено: ${failed.length} (см. консоль).`, 'error');
        } else {
            showStatus('Сохранено! Ждём деплой хостинга...', 'success');
            setDeployBadge('pending', '<i class="fas fa-spinner fa-spin"></i> Деплой...');
            setTimeout(() => { loadSite(true); verifyDeploy(repoDeployId, false); }, 500);
        }
    } catch (e) {
        const i = interpretError(e.status, e.body);
        console.error('[saveAll]', e.status, e.body, e);
        showStatus(`✗ ${i.title}. ${i.fix}`, 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-cloud-upload-alt"></i> Сохранить в GitHub';
    }
}

async function resetSite() {
    if (Object.keys(pending).length && !confirm('Есть несохранённые правки, они будут потеряны. Продолжить?')) return;
    if (!confirm('Переподготовить страницу ' + currentFile + '? Метки будут обновлены.')) return;
    pending = {}; markUnsaved();
    showSetup();
    $('setupTitle').textContent = 'Переподготовка ' + currentFile;
    $('progressLog').style.display = 'none';
    $('errorDetails').innerHTML = '';
}

$('checkBtn').addEventListener('click', checkToken);
$('checkBtn2').addEventListener('click', checkToken);
$('reloadBtn').addEventListener('click', reloadPreview);
$('cleanBtn').addEventListener('click', cleanMarks);
$('resetBtn').addEventListener('click', resetSite);
$('saveBtn').addEventListener('click', saveAll);
$('logoutBtn').addEventListener('click', logout);
$('prepareBtn').addEventListener('click', prepareSite);
$('applyBtn').addEventListener('click', applyEdit);
$('cancelBtn').addEventListener('click', closePanel);
$('closePanelBtn').addEventListener('click', closePanel);
$('homeBtn').addEventListener('click', goHome);
$('openSiteBtn').addEventListener('click', openLiveSite);
$('deployBadge').addEventListener('click', () => verifyDeploy(repoDeployId, true));

window.addEventListener('beforeunload', e => { if (Object.keys(pending).length) { e.preventDefault(); e.returnValue = ''; } });
