// ===== Config =====
const API = 'https://boost-production-9b07.up.railway.app';
const tg = window.Telegram && window.Telegram.WebApp;
const initData = tg ? tg.initData : '';
const LIVE = !!initData; // inside Telegram with initData → talk to the backend
const SLUG_FOR = { it: 'it_service', happy: 'happy_service' };
let catBySlug = {}; // slug → {id, name}

// ---- mock data (demo mode, outside Telegram): RESULT social-proof, not likes ----
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
     do:'Пропоную забрати вже готовий до роботи: оновлення, антивірус, перенос даних. «Заберете і одразу працюєте, без мороки».',
     why:'Знімаю страх «я сам не розберусь» — продаю спокій, а не послугу.'},
    {cat:'IT Service',tier:'NEW',title:'Порівняння двох сервісів замість «так/ні»',
     sub:'Техніка для дому',
     rate:0,tried:0,ok:0,author:'Іван Коваль',
     sit:'Клієнт відмовляється від сервісу одразу.',
     do:'Показую два пакети поруч. Питання вже не «брати чи ні», а «який з двох».',
     why:'Зміщую вибір — і відмова стає рідшою.'}
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

let curCat='it', curItem=null, curList=DATA.it;

// ===== API helpers =====
function api(path, opts){
  opts = opts || {};
  opts.headers = Object.assign({ 'x-telegram-init-data': initData }, opts.headers || {});
  return fetch(API + path, opts).then(r => {
    if(!r.ok) return r.text().then(t => { throw new Error(t || ('HTTP '+r.status)); });
    return r.status === 204 ? null : r.json();
  });
}

function tierOf(tried){ return tried>=10 ? 'TOP' : (tried>0 ? 'GROWING' : 'NEW'); }

// Normalize a backend feed row into the card shape the UI already renders.
function normLive(x, catName){
  return {
    id:x.id, cat:catName, tier:tierOf(x.tried||0), title:x.title,
    sub:x.product_type||'', rate:x.rate||0, tried:x.tried||0, ok:x.ok||0,
    author:x.author||'Продавець', sit:x.sit||'', do:x.do||'', why:x.why||''
  };
}

function loadCats(){
  return api('/categories').then(list => {
    catBySlug = {};
    (list||[]).forEach(c => { catBySlug[c.slug] = { id:c.id, name:c.name }; });
  });
}

function loadFeed(tabKey){
  const slug = SLUG_FOR[tabKey];
  const cat = catBySlug[slug];
  if(!cat){ curList=[]; renderFeed(); return; }
  api('/lifehacks/feed?categoryId=' + encodeURIComponent(cat.id))
    .then(rows => { curList = (rows||[]).map(r => normLive(r, cat.name)); renderFeed(); })
    .catch(e => { curList=[]; renderFeed(); toast('⚠️ '+e.message.slice(0,60)); });
}

// ===== Rendering =====
function renderFeed(){
  const list = curList || [];
  if(!list.length){
    document.getElementById('feed-list').innerHTML =
      '<div class="card" style="cursor:default"><div class="sub">Поки що немає кейсів у цій категорії. Додай перший через «+».</div></div>';
    return;
  }
  document.getElementById('feed-list').innerHTML = list.map((d,i)=>`
    <div class="card" onclick="openDetail(${i})">
      <span class="cat">${d.cat}</span><span class="tier">${d.tier}</span>
      <h3>${d.title}</h3>
      <div class="sub">${d.sub}</div>
      ${d.tried>0 ? `
      <div class="proof">
        <div class="big">${d.rate}%</div>
        <div class="bar"><i style="width:${d.rate}%"></i></div>
        <div class="txt">спрацювало<br>${d.ok} з ${d.tried} підтвердили</div>
      </div>` : `
      <div class="proof" style="background:#f1f5f9">
        <div class="txt" style="color:#64748b">Новий кейс — ще немає підтверджень. Будь першим, хто спробує.</div>
      </div>`}
      <div class="foot">
        <span class="who">${d.author}</span>
        <div class="react">
          <button onclick="event.stopPropagation();tog(this)">👍</button>
          <button onclick="event.stopPropagation();tog(this)">👎</button>
        </div>
      </div>
    </div>`).join('');
}

function switchCat(el,c){
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('on'));
  el.classList.add('on'); curCat=c;
  if(LIVE) loadFeed(c); else { curList=DATA[c]; renderFeed(); }
}

function openDetail(i){
  curItem=curList[i];
  const d=curItem;
  document.getElementById('d-cat').className='card cat';
  document.getElementById('d-cat').outerHTML=`<span class="cat" id="d-cat">${d.cat}</span>`;
  document.getElementById('d-title').textContent=d.title;
  document.getElementById('d-proof').innerHTML = d.tried>0
    ? `<div class="big">${d.rate}%</div><div class="bar"><i style="width:${d.rate}%"></i></div><div class="txt">спрацювало · ${d.ok} з ${d.tried} підтвердили</div>`
    : `<div class="txt" style="color:#64748b">Новий кейс — ще немає підтверджень</div>`;
  document.getElementById('d-proof').style.background = d.tried>0 ? 'var(--good-soft)' : '#f1f5f9';
  document.getElementById('d-sit').textContent=d.sit;
  document.getElementById('d-do').textContent=d.do;
  document.getElementById('d-why').textContent=d.why;
  document.getElementById('d-author').textContent='Автор: '+d.author;
  const t=document.getElementById('d-take'); t.className='take'; t.textContent='📌 Беру в роботу';
  show('detail');
}

let inWork=2;
function takeIt(){
  const t=document.getElementById('d-take');
  t.className='take taken'; t.textContent='✓ В роботі — спитаємо результат за 7 днів';
  inWork++; document.getElementById('inwork-count').textContent=inWork+' кейси в роботі';
  toast('Додано в роботу 📌');
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
  document.getElementById('hint').style.display = s==='feed' ? 'flex':'none';
  document.getElementById('screen-'+s).scrollTop=0;
}

function openConfirm(){ document.getElementById('sheet').classList.add('show'); }
function resolveDemo(msg){
  document.getElementById('sheet').classList.remove('show');
  inWork=Math.max(0,inWork-1);
  document.getElementById('inwork-count').textContent = inWork>0 ? inWork+' кейси в роботі' : 'Немає кейсів у роботі';
  toast(msg);
}

// Select one chip within its group (category / product).
function selectChip(el){
  el.parentElement.querySelectorAll('.chip').forEach(c=>c.classList.remove('on'));
  el.classList.add('on');
}

function publish(){
  if(!LIVE){ toast('Кейс опубліковано ✅'); setTimeout(()=>show('feed'),700); return; }
  const catEl = document.querySelector('#cat-chips .chip.on');
  const prodEl = document.querySelector('#prod-chips .chip.on');
  const title = (document.getElementById('c-title').value||'').trim();
  const body = (document.getElementById('c-body').value||'').trim();
  if(!title){ toast('Додай заголовок'); return; }
  const payload = {
    categorySlug: catEl ? catEl.getAttribute('data-slug') : 'it_service',
    productType: prodEl ? prodEl.textContent.trim() : '',
    title,
    content: { do: body }
  };
  api('/lifehacks', {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body: JSON.stringify(payload)
  }).then(()=>{
    toast('Кейс опубліковано ✅');
    document.getElementById('c-title').value='';
    document.getElementById('c-body').value='';
    // reload the feed tab matching the published category
    const tabKey = (payload.categorySlug==='happy_service') ? 'happy' : 'it';
    curCat = tabKey;
    document.querySelectorAll('.tab').forEach((t,idx)=>t.classList.toggle('on', (idx===0)===(tabKey==='it')));
    loadFeed(tabKey);
    setTimeout(()=>show('feed'),700);
  }).catch(e => toast('⚠️ '+e.message.slice(0,60)));
}

// Voice cases are recorded in the bot chat (native mic = zero friction).
function recordVoice(){
  if(tg && tg.close){
    toast('🎙️ Запиши голосове боту');
    setTimeout(()=>tg.close(), 700);
  } else {
    toast('🎙️ Відкрий у Telegram, щоб записати голосове');
  }
}

let tT;
function toast(m){
  const t=document.getElementById('toast'); t.textContent=m; t.classList.add('show');
  clearTimeout(tT); tT=setTimeout(()=>t.classList.remove('show'),1800);
}

// ===== Init =====
if(LIVE){
  try{ tg.ready(); tg.expand(); }catch(e){}
  loadCats().then(()=>loadFeed('it')).catch(e=>{ curList=[]; renderFeed(); toast('⚠️ '+e.message.slice(0,60)); });
} else {
  curList = DATA.it; renderFeed();
}

// Theme management
function applyTheme(theme){
  const phone=document.querySelector('.phone');
  const toggle=document.getElementById('theme-toggle');
  if(theme==='dark'){
    phone.classList.add('dark');
    toggle.textContent='☀️';
  } else {
    phone.classList.remove('dark');
    toggle.textContent='🌙';
  }
  localStorage.setItem('theme',theme);
}

function toggleTheme(){
  const phone=document.querySelector('.phone');
  const isDark=phone.classList.contains('dark');
  applyTheme(isDark?'light':'dark');
}

// Initialize theme
const saved=localStorage.getItem('theme');
const pref=window.matchMedia('(prefers-color-scheme:dark)').matches;
const initial=saved||( pref?'dark':'light');
applyTheme(initial);

// Hide splash after animation
setTimeout(()=>{
  const splash=document.getElementById('splash');
  if(splash) splash.style.display='none';
},1200);
