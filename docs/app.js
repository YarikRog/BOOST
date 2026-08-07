// ===== Config =====
const API = 'https://boost-production-9b07.up.railway.app';
const tg = window.Telegram && window.Telegram.WebApp;
const initData = tg ? tg.initData : '';
const LIVE = !!initData; // inside Telegram with initData → talk to the backend
const SLUG_FOR = { it: 'it_service', happy: 'happy_service' };
const TAB_FOR = { it_service: 'it', happy_service: 'happy' };
const PRODUCTS = {
  it_service: ['Смартфони', 'Планшети', 'Ноутбуки'],
  happy_service: ['Холодильники', 'Пральні машини', 'Телевізори'],
};
const ROLE_LABELS = {
  MEGA_ADMIN: 'Адміністратор',
  REGIONAL_IT_LEAD: 'Регіональний ІТ-лід',
  DIRECTOR: 'Директор (Store IT-лід)',
  DEP_DIRECTOR: 'Заступник директора',
  SELLER: 'Продавець (IT-експерт)',
};
let catBySlug = {}; // slug → {id, name}
let me = null;      // current user (live mode)

// ---- mock data (demo mode, outside Telegram) ----
const DATA = {
  it: [
    {cat:'IT Service',tier:'TOP',title:'Гарантія через питання, а не через тиск',
     sub:'Ноутбуки · для невпевненого клієнта',
     rate:82,tried:22,ok:18,author:'Store Київ 22',
     sit:'Клієнт каже «мені гарантія не потрібна, я акуратний».',
     do:'Не сперечаюсь. Питаю: «А якщо через рік мати випадково заллє клавіатуру — у скільки обійдеться ремонт?» Даю йому самому назвати суму.',
     why:'Людина сама усвідомлює ризик і називає ціну — це сильніше за будь-який мій аргумент.'},
    {cat:'IT Service',tier:'GROWING',title:'Налаштування «під ключ» як причина сервісу',
     sub:'Ноутбуки · купує вперше',
     rate:74,tried:19,ok:14,author:'Region Lead',
     sit:'Клієнт вперше купує ноутбук і трохи губиться.',
     do:'Пропоную забрати вже готовий до роботи: оновлення, антивірус, перенос даних.',
     why:'Знімаю страх «я сам не розберусь» — продаю спокій, а не послугу.'}
  ],
  happy: [
    {cat:'Happy Service',tier:'TOP',title:'Емоція до того, як назвав ціну',
     sub:'ТВ · родина з дітьми',
     rate:88,tried:25,ok:22,author:'Store Лавіна',
     sit:'Сім’я обирає телевізор, дивляться на ціну першою.',
     do:'Спочатку даю уявити: «Уявіть вечір п’ятниці, всі разом, цей екран». Ціну називаю після картинки.',
     why:'Емоція формує цінність — ціна сприймається легше.'}
  ]
};

let curCat='it', curItem=null, curList=DATA.it, createSlug='it_service';

// ===== API helpers =====
function api(path, opts){
  opts = opts || {};
  opts.headers = Object.assign({ 'x-telegram-init-data': initData }, opts.headers || {});
  return fetch(API + path, opts).then(r => {
    if(!r.ok) return r.text().then(t => { throw new Error(t || ('HTTP '+r.status)); });
    return r.status === 204 ? null : r.json();
  });
}

function isMine(item){ return LIVE && me && item && item.author_id === me.id; }

let myReacts = {}; // lifehack_id → 'like' | 'dislike'

// ===== Read/unread tracking (per-device, localStorage — no backend needed) =====
const SEEN_KEY = 'boost_seen_ids';
let seenIds = new Set();
try { seenIds = new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]')); } catch(e) {}
function isUnread(d){ return !isMine(d) && !seenIds.has(d.id); }
function markSeen(id){
  if(seenIds.has(id)) return;
  seenIds.add(id);
  // Cap stored history so this never grows unbounded on a long-lived device.
  const arr = Array.from(seenIds);
  if(arr.length > 500) arr.splice(0, arr.length - 500);
  localStorage.setItem(SEEN_KEY, JSON.stringify(arr));
}

// Tier and quality come from the backend — never recomputed here, or the UI
// and the ranking engine would disagree about what a case is worth.
function normLive(x, catName){
  return {
    id:x.id, author_id:x.author_id, cat:catName, tier:x.tier||'NEW', title:x.title,
    sub:x.product_type||'', rate:x.rate||0, tried:x.tried||0, ok:x.ok||0,
    author:x.author||'Продавець', sit:x.sit||'', do:x.do||'', why:x.why||'', has_voice:!!x.has_voice,
    voice_url:x.voice_url||null, likes:x.likes||0, dislikes:x.dislikes||0
  };
}

function loadMyReactions(){
  return api('/lifehacks/my-reactions').then(list => {
    myReacts = {};
    (list||[]).forEach(r => { myReacts[r.lifehack_id] = r.type; });
  }).catch(()=>{});
}

// Toggle a like/dislike on the backend, then reflect it on the two buttons.
function reactTo(ev, id, type, btn){
  if(ev) ev.stopPropagation();
  if(!LIVE){ tog(btn); return; }
  api('/lifehacks/'+encodeURIComponent(id)+'/react', {
    method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ type })
  }).then(res => {
    myReacts[id] = res.type; // 'like' | 'dislike' | null
    const wrap = btn.parentElement;
    const [likeBtn, disBtn] = wrap.querySelectorAll('button');
    likeBtn.classList.toggle('on', res.type==='like');
    disBtn.classList.toggle('on', res.type==='dislike');
  }).catch(e => toast('⚠️ '+e.message.slice(0,50)));
}

function loadMe(){
  return api('/auth/telegram', {
    method:'POST', headers:{ 'content-type':'application/json' },
    body: JSON.stringify({ initData })
  }).then(u => {
    me = u;
    // Header
    document.querySelector('.store .meta b').textContent = 'Comfy · ' + (u.storeName || 'магазин');
    document.getElementById('roleline').textContent = ROLE_LABELS[u.role] || 'Продавець';
    // Profile
    const nm = u.name || 'Продавець';
    document.querySelector('.prof-top .avatar').textContent = nm.trim().charAt(0).toUpperCase() || 'П';
    document.querySelector('.prof-top b').textContent = nm;
    document.querySelector('.prof-top div div').textContent =
      (ROLE_LABELS[u.role]||'Продавець') + ' · Comfy ' + (u.storeName || '');
  });
}

function loadStats(){
  return api('/lifehacks/me/stats').then(s => {
    document.getElementById('st-written').textContent = s.written ?? 0;
    document.getElementById('st-confirmed').textContent = s.confirmed ?? 0;
    document.getElementById('st-eff').textContent = (s.effectiveness ?? 0) + '%';
    const by = s.byCategory || {};
    document.getElementById('st-cat-it').textContent = (by.it_service || 0) + ' кейс(ів)';
    document.getElementById('st-cat-happy').textContent = (by.happy_service || 0) + ' кейс(ів)';
  }).catch(()=>{});
}

function loadCats(){
  return api('/categories').then(list => {
    catBySlug = {};
    (list||[]).forEach(c => { catBySlug[c.slug] = { id:c.id, name:c.name }; });
  });
}

const CAT_NAME = { it_service:'IT Service', happy_service:'Happy Service' };
const feedCache = {}; // tabKey -> normalized array (instant tab switches)

function fetchFeed(tabKey){
  const slug = SLUG_FOR[tabKey];
  return api('/lifehacks/feed?categorySlug=' + encodeURIComponent(slug))
    .then(rows => {
      const list = (rows||[]).map(r => normLive(r, CAT_NAME[slug]||''));
      feedCache[tabKey] = list;
      return list;
    });
}

// Show a tab instantly from cache (if any), then refresh in the background.
function loadFeed(tabKey, dir){
  if(feedCache[tabKey]){
    curList = feedCache[tabKey]; renderFeed(dir);
    fetchFeed(tabKey).then(list => { if(curCat===tabKey){ curList=list; renderFeed(); } }).catch(()=>{});
  } else {
    fetchFeed(tabKey)
      .then(list => { if(curCat===tabKey){ curList=list; renderFeed(dir); } })
      .catch(e => { if(curCat===tabKey){ curList=[]; renderFeed(dir); } toast('⚠️ '+e.message.slice(0,60)); });
  }
}

// Warm a tab into cache without rendering (called for the other tab on start).
function prefetchFeed(tabKey){ fetchFeed(tabKey).catch(()=>{}); }

// ===== Feed rendering =====
function playSlide(dir){
  if(!dir) return;
  const el=document.getElementById('feed-list');
  el.classList.remove('slide-r','slide-l');
  void el.offsetWidth; // restart animation
  el.classList.add(dir==='r' ? 'slide-r' : 'slide-l');
}

function renderFeed(dir){
  const list = curList || [];
  if(!list.length){
    document.getElementById('feed-list').innerHTML =
      '<div class="card" style="cursor:default"><div class="sub">Поки що немає кейсів у цій категорії. Додай перший через «+».</div></div>';
    playSlide(dir);
    return;
  }
  document.getElementById('feed-list').innerHTML = list.map((d,i)=>{
    const mine = isMine(d);
    const proof = d.tried>0 ? `
      <div class="proof">
        <div class="big">${d.rate}%</div>
        <div class="bar"><i style="width:${d.rate}%"></i></div>
        <div class="txt">успішних спроб<br>${d.ok} з ${d.tried} підтвердили</div>
      </div>` : `
      <div class="proof" style="background:var(--chip)">
        <div class="txt" style="color:var(--muted)">Новий кейс — ще немає підтверджень. Будь першим, хто спробує.</div>
      </div>`;
    const foot = mine ? `
      <div class="foot"><span class="who">Твій кейс</span>
        <span style="font-size:12px;color:var(--good)">🟢 опубліковано</span></div>` : `
      <div class="foot">
        <span class="who">${d.author}</span>
        <div class="react">
          <button class="${myReacts[d.id]==='like'?'on':''}" onclick="reactTo(event,'${d.id}','like',this)">👍 ${d.likes||''}</button>
          <button class="${myReacts[d.id]==='dislike'?'on':''}" onclick="reactTo(event,'${d.id}','dislike',this)">👎 ${d.dislikes||''}</button>
        </div>
      </div>`;
    const unread = isUnread(d);
    return `
    <div class="card${unread?' unread':''}" onclick="openDetail(${i})">
      ${unread?'<span class="new-dot"></span>':''}
      <span class="cat">${d.cat}</span><span class="tier">${d.tier}</span>
      <h3>${d.has_voice?'🎙️ ':''}${d.title}</h3>
      <div class="sub">${d.sub}${d.has_voice?' · голосовий':''}</div>
      ${proof}
      ${foot}
    </div>`;
  }).join('');
  playSlide(dir);
}

const TAB_ORDER = ['it','happy'];
function switchCat(el,c){
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('on'));
  el.classList.add('on');
  const dir = TAB_ORDER.indexOf(c) > TAB_ORDER.indexOf(curCat) ? 'r' : 'l';
  curCat=c;
  if(LIVE) loadFeed(c, dir); else { curList=DATA[c]; renderFeed(dir); }
}

function openDetail(i){
  curItem=curList[i];
  const d=curItem;
  const mine = isMine(d);
  if(isUnread(d)){
    markSeen(d.id);
    const cardEl = document.querySelectorAll('#feed-list .card')[i];
    if(cardEl){ cardEl.classList.remove('unread'); const dot=cardEl.querySelector('.new-dot'); if(dot) dot.remove(); }
  }
  document.getElementById('d-cat').className='card cat';
  document.getElementById('d-cat').outerHTML=`<span class="cat" id="d-cat">${d.cat}</span>`;
  document.getElementById('d-title').textContent=d.title;
  document.getElementById('d-proof').innerHTML = d.tried>0
    ? `<div class="big">${d.rate}%</div><div class="bar"><i style="width:${d.rate}%"></i></div><div class="txt">успішних спроб · ${d.ok} з ${d.tried} підтвердили</div>`
    : `<div class="txt" style="color:var(--muted)">Новий кейс — ще немає підтверджень</div>`;
  document.getElementById('d-proof').style.background = d.tried>0 ? 'var(--good-soft)' : 'var(--chip)';
  const doText = d.has_voice ? '🎧 Голосовий кейс — послухай запис вище.' : d.do;
  document.getElementById('d-sit').textContent = d.sit;
  document.getElementById('d-do').textContent = doText;
  document.getElementById('d-why').textContent = d.why;
  // Hide empty blocks (the current form only fills "Що кажу / роблю").
  const hideEmpty = (pid, has)=>{ const p=document.getElementById(pid); if(p&&p.parentElement) p.parentElement.classList.toggle('hidden', !has); };
  hideEmpty('d-sit', !!(d.sit && d.sit.trim()));
  hideEmpty('d-do', !!(doText && doText.trim()));
  hideEmpty('d-why', !!(d.why && d.why.trim()));
  // Voice player
  const audio=document.getElementById('d-audio');
  if(LIVE && d.has_voice && d.id){
    // Prefer our own storage copy; fall back to streaming via the backend.
    // The fallback stream is authenticated too; <audio> can't set headers, so
    // initData rides along as a query param and is HMAC-verified server-side.
    audio.src = d.voice_url ||
      (API + '/lifehacks/' + encodeURIComponent(d.id) + '/voice?initData=' + encodeURIComponent(initData));
    audio.classList.remove('hidden');
  } else {
    audio.classList.add('hidden'); audio.removeAttribute('src');
  }
  document.getElementById('d-author').textContent='Автор: '+d.author;
  // You cannot take or react to your own case.
  document.getElementById('d-react-card').classList.toggle('hidden', mine);
  document.getElementById('d-take').classList.toggle('hidden', mine);
  document.getElementById('d-mine-note').classList.toggle('hidden', !mine);
  // Delete: author, or admin on any case.
  const canDelete = LIVE && me && (mine || me.role==='MEGA_ADMIN' || me.role==='REGIONAL_IT_LEAD');
  document.getElementById('d-delete').classList.toggle('hidden', !canDelete);
  const t=document.getElementById('d-take'); t.className='take'; t.textContent='📌 Беру в роботу';
  if(mine) t.classList.add('hidden');
  // Wire reaction buttons to the current case.
  const likeBtn=document.getElementById('d-like'), disBtn=document.getElementById('d-dislike');
  if(likeBtn && disBtn){
    likeBtn.classList.toggle('on', myReacts[d.id]==='like');
    disBtn.classList.toggle('on', myReacts[d.id]==='dislike');
    likeBtn.textContent = '👍 ' + (d.likes||'');
    disBtn.textContent = '👎 ' + (d.dislikes||'');
    likeBtn.onclick = (e)=>reactTo(e, d.id, 'like', likeBtn);
    disBtn.onclick = (e)=>reactTo(e, d.id, 'dislike', disBtn);
  }
  show('detail');
}

function deleteCase(){
  if(!curItem || !curItem.id) return;
  const id = curItem.id;
  const doDel = ()=> api('/lifehacks/'+encodeURIComponent(id)+'/delete', { method:'POST' })
    .then(()=>{ toast('Кейс видалено 🗑'); loadStats(); delete feedCache[curCat]; loadFeed(curCat); setTimeout(()=>show('feed'),500); })
    .catch(e => toast('⚠️ '+e.message.slice(0,60)));
  if(tg && tg.showConfirm){ tg.showConfirm('Видалити цей кейс?', ok=>{ if(ok) doDel(); }); }
  else if(confirm('Видалити цей кейс?')){ doDel(); }
}

// Work items in progress. Demo mode seeds one so the flow is clickable offline.
let activeItems = [];
let demoActive = [{ id:'d1', title:'Гарантія через питання' }];
function activeList(){ return LIVE ? activeItems : demoActive; }

function loadActive(){
  return api('/work-items/active')
    .then(list => { activeItems = list || []; updateInwork(); })
    .catch(()=>{ activeItems = []; updateInwork(); });
}

function takeIt(){
  if(!LIVE){
    const t=document.getElementById('d-take');
    t.className='take taken'; t.textContent='✓ В роботі — спитаємо результат за 7 днів';
    demoActive.push({ id:'d'+Date.now(), title:curItem.title }); updateInwork();
    toast('Додано в роботу 📌'); return;
  }
  api('/lifehacks/'+encodeURIComponent(curItem.id)+'/take', { method:'POST' })
    .then(w => {
      const t=document.getElementById('d-take');
      t.className='take taken'; t.textContent='✓ В роботі — спитаємо результат за 7 днів';
      activeItems.push({ id:w.id, title:curItem.title }); updateInwork();
      toast('Додано в роботу 📌');
    })
    .catch(e => toast('⚠️ '+e.message.slice(0,70)));
}

function updateInwork(){
  const count = activeList().length;
  const el=document.getElementById('inwork-count');
  const banner=document.querySelector('.inwork');
  if(count>0){ el.textContent=count+' кейс(и) в роботі'; banner.style.display='flex'; }
  else banner.style.display='none';
}

function tog(b){
  const was=b.classList.contains('on');
  b.parentElement.querySelectorAll('button').forEach(x=>x.classList.remove('on'));
  if(!was) b.classList.add('on');
}

function show(s){
  ['feed','detail','create','profile'].forEach(x=>{
    document.getElementById('screen-'+x).classList.toggle('hidden', x!==s);
  });
  document.getElementById('nav-feed').classList.toggle('on', s==='feed'||s==='detail');
  document.getElementById('nav-profile').classList.toggle('on', s==='profile');
  document.getElementById('hint').style.display = (s==='feed' && !LIVE) ? 'flex':'none';
  document.getElementById('screen-'+s).scrollTop=0;
}

function openConfirm(){ renderSheet(); document.getElementById('sheet').classList.add('show'); }
function closeConfirm(){ document.getElementById('sheet').classList.remove('show'); }

function renderSheet(){
  const items = activeList();
  const body = document.getElementById('sheet-body');
  if(!items.length){ body.innerHTML='<h4>Немає кейсів у роботі</h4>'; return; }
  const w = items[0];
  body.innerHTML =
    `<h4>Кейс «${w.title}»</h4>`+
    `<div class="q">Ти брав його в роботу. Спрацювало?</div>`+
    `<div class="opt">`+
      `<button class="g" onclick="resolveWork('${w.id}','success')">🔥 Так, продав</button>`+
      `<button onclick="resolveWork('${w.id}','partial')">😐 Частково</button>`+
      `<button onclick="resolveWork('${w.id}','fail')">❌ Ні</button>`+
      `<button onclick="resolveWork('${w.id}','not_tried')">⏭ Не пробував</button>`+
    `</div>`;
}

function resolveWork(id, outcome){
  const label = { success:'🔥 Зараховано як успіх', partial:'Дякуємо за відповідь',
    fail:'Дякуємо за відповідь', not_tried:'Не враховується в рейтинг' }[outcome];
  const done = ()=>{
    if(LIVE) activeItems = activeItems.filter(x=>x.id!==id);
    else demoActive = demoActive.filter(x=>x.id!==id);
    updateInwork();
    if(activeList().length) renderSheet(); else closeConfirm();
    toast(label);
  };
  if(!LIVE){ done(); return; }
  api('/work-items/'+encodeURIComponent(id)+'/result', {
    method:'POST', headers:{ 'content-type':'application/json' },
    body: JSON.stringify({ outcome })
  }).then(done).catch(e => toast('⚠️ '+e.message.slice(0,60)));
}

// ===== Create flow (minimal taps) =====
function selectChip(el){
  el.parentElement.querySelectorAll('.chip').forEach(c=>c.classList.remove('on'));
  el.classList.add('on');
  if(el.parentElement.id==='cat-chips'){
    createSlug = el.getAttribute('data-slug');
    renderProducts(createSlug);
  }
}

function renderProducts(slug){
  const list = PRODUCTS[slug] || [];
  // Nothing pre-selected — the user picks the product themselves.
  document.getElementById('prod-chips').innerHTML = list.map((p)=>
    `<div class="chip" onclick="selectChip(this)">${p}</div>`).join('');
}

// "+" → open a clean create screen: nothing pre-selected, user chooses.
function openCreate(){
  createSlug = '';
  document.querySelectorAll('#cat-chips .chip').forEach(c=>c.classList.remove('on'));
  document.getElementById('prod-chips').innerHTML =
    '<div class="sub" style="font-size:12px">Обери категорію вище →</div>';
  document.getElementById('c-title').value='';
  document.getElementById('c-body').value='';
  show('create');
}

function publish(){
  const prodEl = document.querySelector('#prod-chips .chip.on');
  let title = (document.getElementById('c-title').value||'').trim();
  const body = (document.getElementById('c-body').value||'').trim();
  if(!createSlug){ toast('Обери категорію'); return; }
  if(!body){ toast('Опиши кейс кількома словами'); return; }
  if(!title) title = body.split(/[.!?\n]/)[0].slice(0,60); // derive from first sentence

  if(!LIVE){ toast('Кейс опубліковано ✅'); setTimeout(()=>show('feed'),700); return; }

  const payload = {
    categorySlug: createSlug,
    productType: prodEl ? prodEl.textContent.trim() : '',
    title,
    content: { do: body }
  };
  api('/lifehacks', {
    method:'POST', headers:{ 'content-type':'application/json' },
    body: JSON.stringify(payload)
  }).then(()=>{
    toast('Кейс опубліковано ✅');
    document.getElementById('c-title').value='';
    document.getElementById('c-body').value='';
    const tabKey = TAB_FOR[createSlug] || 'it';
    curCat = tabKey;
    document.querySelectorAll('.tab').forEach(t=>t.classList.remove('on'));
    const tabEls = document.querySelectorAll('.tab');
    (tabKey==='it' ? tabEls[0] : tabEls[1]).classList.add('on');
    delete feedCache[tabKey]; // new case published → refetch fresh
    loadFeed(tabKey);
    setTimeout(()=>show('feed'),700);
  }).catch(e => toast('⚠️ '+e.message.slice(0,60)));
}

// Voice cases are recorded in the bot chat (native mic = zero friction).
function recordVoice(){
  const catEl = document.querySelector('#cat-chips .chip.on');
  const prodEl = document.querySelector('#prod-chips .chip.on');
  if(!catEl){ toast('Спочатку обери категорію'); return; }
  if(!(tg && tg.close)){ toast('Відкрий у Telegram, щоб записати голосове'); return; }
  if(!LIVE){ toast('У Telegram запишеш голосове боту'); return; }
  const payload = {
    categorySlug: catEl.getAttribute('data-slug'),
    productType: prodEl ? prodEl.textContent.trim() : ''
  };
  api('/lifehacks/voice-intent', {
    method:'POST', headers:{ 'content-type':'application/json' },
    body: JSON.stringify(payload)
  }).then(()=>{
    toast('Тепер запиши голосове боту');
    setTimeout(()=>tg.close(), 900);
  }).catch(e => toast('warn '+e.message.slice(0,60)));
}

let tT;
function toast(m){
  const t=document.getElementById('toast'); t.textContent=m; t.classList.add('show');
  clearTimeout(tT); tT=setTimeout(()=>t.classList.remove('show'),1800);
}

// ===== Init =====
renderProducts('it_service');
if(LIVE){
  document.body.classList.add('tg'); // fill the whole Telegram webview
  try{ tg.ready(); tg.expand(); }catch(e){}
  // Stop the pull-down gesture from dragging the app / losing the bottom nav.
  try{ tg.disableVerticalSwipes && tg.disableVerticalSwipes(); }catch(e){}
  updateInwork(); // hide the in-work banner until real active items load
  // In live mode the prototype scaffolding is off.
  const ribbon=document.querySelector('.ribbon'); if(ribbon) ribbon.style.display='none';
  const hint=document.getElementById('hint'); if(hint) hint.style.display='none';
  // Load the viewer's reactions first (so the feed can highlight), then the feed.
  // Warm the other tab in the background so switching is instant.
  loadMyReactions().finally(()=>{ loadFeed('it'); prefetchFeed('happy'); });
  // Everything else loads in parallel and updates the UI when ready.
  loadMe().then(loadStats).catch(()=>{});
  loadActive().catch(()=>{});
} else {
  curList = DATA.it; renderFeed(); updateInwork();
}

// ===== Theme =====
function applyTheme(theme){
  const phone=document.querySelector('.phone');
  const toggle=document.getElementById('theme-toggle');
  const dark = theme==='dark';
  phone.classList.toggle('dark', dark);
  document.body.classList.toggle('dark', dark); // for body.tg.dark background
  toggle.textContent = dark ? '☀️' : '🌙';
  localStorage.setItem('theme',theme);
}
function toggleTheme(){
  const phone=document.querySelector('.phone');
  applyTheme(phone.classList.contains('dark')?'light':'dark');
}
const saved=localStorage.getItem('theme');
const pref=window.matchMedia('(prefers-color-scheme:dark)').matches;
applyTheme(saved||(pref?'dark':'light'));

// When a field is focused, scroll it into view above the on-screen keyboard.
['c-title','c-body'].forEach(id=>{
  const el=document.getElementById(id);
  if(el) el.addEventListener('focus', ()=>{
    setTimeout(()=>{ try{ el.scrollIntoView({block:'center', behavior:'smooth'}); }catch(e){} }, 300);
  });
});

// Onboarding (first launch, re-openable from profile).
// Force display via inline style too, so a stale cached CSS can't keep it stuck.
function showOnboarding(){
  const o=document.getElementById('onb');
  o.style.display='flex'; o.classList.remove('hidden');
}
function dismissOnboarding(){
  const o=document.getElementById('onb');
  o.style.display='none'; o.classList.add('hidden');
  localStorage.setItem('boost_onboarded','1');
}

// Hide splash after animation, then show onboarding on first launch.
setTimeout(()=>{
  const s=document.getElementById('splash'); if(s) s.style.display='none';
  if(!localStorage.getItem('boost_onboarded')) showOnboarding();
},1250);
