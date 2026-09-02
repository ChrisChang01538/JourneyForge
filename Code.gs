/**
 * 訪視行程規劃工具 — Apps Script 後端
 * ---------------------------------------------------------------------------
 * 「專案設定 → 指令碼屬性」要建的項目：
 *
 *   ACCESS_KEY          必填。自己想一組通行碼，發給同事，前端設定要填一樣的。
 *                       留空的話等於完全不設防，任何拿到網址的人都能用你的額度。
 *   SHEET_ID            必填。Google 試算表 ID（網址 /d/ 與 /edit 之間那段）。
 *   MAPS_KEY            選填。Google Cloud 金鑰，要啟用 Geocoding API 與
 *                       Places API (New)。沒填就不能精確定位、不能搜午餐。
 *   TDX_CLIENT_ID       選填。TDX 運輸資料流通服務的金鑰，用來更新高鐵班表。
 *   TDX_CLIENT_SECRET   選填。到 https://tdx.transportdata.tw 免費註冊後取得。
 *   FEEDBACK_FOLDER_ID  不用自己填。第一次有人送出帶截圖的回饋時，程式會在這個
 *                       帳號的雲端硬碟建一個「JourneyForge 回饋附件」資料夾，
 *                       並把 ID 寫回這裡。想改放到別的資料夾就手動覆蓋這一項。
 *   ADMIN_USER / ADMIN_SALT / ADMIN_HASH
 *                       後台（admin.html）的登入帳密，不要手動填。在編輯器執行一次
 *                       setAdmin('帳號','密碼') 就會寫進去，只存雜湊不存明碼。
 *
 * 高鐵班表怎麼更新：使用者端不會呼叫 TDX，只會讀試算表。
 * 由你在 Apps Script 編輯器手動執行 refreshTimetable()，或設一個「時間驅動」觸發程序
 * （例如每月一次）自動跑。跑完「班表」分頁就是最新的，前端會顯示更新日期。
 * 抓的是「定期時刻表」（例行班表），不含疏運或加班車。
 *
 * ⚠ 26.02 起多了「回饋」功能，會用到雲端硬碟（DriveApp）。從舊版更新上來的話，
 *   重新部署後第一次執行會要求「重新授權」，多勾一項雲端硬碟權限，這是正常的。
 *
 * 部署：右上「部署 → 新增部署作業 → 網頁應用程式」
 *   執行身分：我　　誰可以存取：任何人
 * 靜態網頁只能呼叫「任何人」等級的 Web App，所以才需要 ACCESS_KEY 當閘門。
 * 部署後複製 /exec 結尾的網址，貼進前端設定。
 *
 * 試算表的分頁會自動建立，不必手動開：
 *   地點快取   地址 | 緯度 | 經度 | 更新時間
 *   餐廳快取   格號 | 名稱 | 地址 | 緯度 | 經度 | 評分 | 價位 | 營業時間JSON | 更新時間
 *   案件       案件ID | 標題 | 日期 | 訪視家數 | 建立時間 | 更新時間 | Markdown | JSON
 *              Markdown 給人看，JSON 給程式還原成可編輯的行程。同一個案件ID 會更新既有列。
 *   回饋       收件編號 | 時間 | 使用者 | 版本 | 分類 | 滿意度 | 內容 | 附件 | 環境 | 狀態 | 處理備註
 *              使用者在工具右下角「意見回饋」送出的內容。狀態預設「待處理」，
 *              由維護者判斷要不要升成 FEEDBACK.md 裡的 FB-0xx。
 *              截圖存到雲端硬碟，這裡只放連結；附件不對外開放，要用這個帳號才看得到。
 *   使用紀錄   時間 | 使用者 | 動作 | 案件ID | 標題 | 天數 | 站數
 *              管考用。前端射後不理，寫失敗不影響使用者操作。
 *   錯誤       時間 | 使用者 | 版本 | 來源 | 動作 | 訊息 | 詳細 | 環境 | 狀態
 *              前端 reportErr() 送來的失敗紀錄，後台「錯誤與健康」看這張。
 *   用量       日期 | geocode呼叫 | geocode快取命中 | places呼叫 | places快取命中
 *              一天一列，後台「成本與配額」據此估算費用與快取效益。
 *   班表       方向 | 車次 | 行駛日 | 十二個站別欄位 | 更新日期
 *              一列一班車。站別欄位填該班車在那一站的停靠時刻：
 *                空白        該站不停
 *                08:26-08:28 到站-開車
 *                06:30       起站或終點站，只有一個時間
 *              行駛日空白＝每日行駛；有限制才填，0 是週日、1 到 6 是週一到週六。
 * ---------------------------------------------------------------------------
 */

var REST_CACHE_DAYS  = 45;   // 餐廳快取幾天後重查
var GRID = 0.02;             // 餐廳快取的網格精度，約 2 公里

/* ========================= 儲存健康度門檻 =========================
   兩個上限是 Google 定的、改不了的：
     單一儲存格 50,000 字元 —— 案件的 JSON 就存在一格裡，爆掉是那一件存不進去
     單份試算表 1,000 萬格   —— 爆掉是整份一起死，回饋、使用紀錄、錯誤全部寫不進去
   下面是我們自己設的警戒線，黃燈約七成、紅燈約九成。要調就改這裡，
   後台的燈號與 saveCase_ 的硬擋都吃同一組值。                        */
var CELL_MAX       = 50000;      // Google 的硬限制，不要改
var CELL_WARN      = 35000;      // 黃：70%
var CELL_STOP      = 45000;      // 紅：90%，寫入端到這裡就擋
var CELLS_MAX      = 10000000;   // Google 的硬限制，不要改
var CELLS_WARN     = 7000000;
var CELLS_STOP     = 9000000;
var SCAN_WARN_MS   = 2000;       // 案件分頁整張讀進來要多久
var SCAN_STOP_MS   = 5000;
var CASE_ROW_WARN  = 2000;       // 案件列數，線性掃描大概從這裡開始有感
var CASE_ROW_STOP  = 5000;

function doPost(e) {
  var out;
  try {
    var req = JSON.parse(e.postData.contents || '{}');

    // 後台自己一組帳密（見檔案末段的「後台」區塊），不吃 ACCESS_KEY。
    // ACCESS_KEY 是發給全體使用者的，拿得到工具就拿得到它，不能用來擋管考資料。
    if (req.action && req.action.indexOf('admin') === 0) {
      return ContentService.createTextOutput(JSON.stringify({ ok: true, data: admin_(req) }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    var need = prop_('ACCESS_KEY');
    if (need && req.key !== need) throw new Error('通行碼不正確');

    switch (req.action) {
      case 'ping':    out = { ok: true, data: status_(req) }; break;
      case 'geocode': out = { ok: true, data: geocode_(req.addresses || []) }; break;
      case 'lunch':   out = { ok: true, data: lunch_(req) }; break;
      case 'timetable': out = { ok: true, data: timetable_(req) }; break;
      case 'saveCase':  out = { ok: true, data: saveCase_(req) }; break;
      case 'loadCase':  out = { ok: true, data: loadCase_(req) }; break;
      case 'listCases': out = { ok: true, data: listCases_() }; break;
      case 'feedback':  out = { ok: true, data: feedback_(req) }; break;
      case 'log':       out = { ok: true, data: log_(req) }; break;
      case 'err':       out = { ok: true, data: err_(req) }; break;
      default: throw new Error('不認得的 action：' + req.action);
    }
  } catch (err) {
    out = { ok: false, error: String(err && err.message ? err.message : err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return ContentService.createTextOutput('訪視行程規劃工具後端已上線。請用 POST 呼叫。');
}

/* ========================= 共用 ========================= */
function prop_(k) {
  return PropertiesService.getScriptProperties().getProperty(k);
}
function sheet_(name, header) {
  var ss = SpreadsheetApp.openById(prop_('SHEET_ID'));
  var sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); sh.appendRow(header); sh.setFrozenRows(1); }
  return sh;
}
function fresh_(ts, days) {
  return ts ? (new Date() - new Date(ts)) < days * 86400000 : false;
}
function today_() {
  return Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd');
}
/* ========================= 意見回饋 ========================= */
/**
 * 前端右下角「意見回饋」送過來的內容。
 * 截圖走 Drive、文字走試算表：試算表儲存格有五萬字上限，圖片塞不進去，
 * 而且附件放 Drive 之後，維護者可以直接在資料夾裡一次看完所有截圖。
 */
function feedback_(req) {
  var text = String(req.text || '').trim();
  if (!text) throw new Error('回饋內容是空的');
  if (text.length > 5000) text = text.slice(0, 5000) + '…（超過 5000 字，已截斷）';

  var sh = sheet_('回饋', ['收件編號', '時間', '使用者', '版本', '分類', '滿意度',
                          '內容', '附件', '環境', '狀態', '處理備註']);
  var id = 'R-' + ('0000' + sh.getLastRow()).slice(-4);   // 標題列算第 1 列，首筆就是 R-0001

  var links = [];
  var files = (req.files || []).slice(0, 3);
  for (var i = 0; i < files.length; i++) {
    try {
      links.push(fbSave_(files[i], id, i + 1));
    } catch (e) {
      links.push('（第 ' + (i + 1) + ' 張存檔失敗：' + e.message + '）');
    }
  }

  var rate = Number(req.rate || 0);
  sh.appendRow([
    id, new Date(), String(req.user || ''), String(req.app || ''),
    String(req.cat || ''), rate ? rate + ' / 5' : '',
    text, links.join('\n'),
    req.env ? JSON.stringify(req.env) : '',
    '待處理', ''
  ]);
  return { id: id, files: links.length };
}

/** 一張截圖存進雲端硬碟，回傳連結。刻意不開共用連結——回饋截圖可能有單位名稱。 */
function fbSave_(f, id, n) {
  var b64 = String(f && f.b64 || '');
  if (!b64) throw new Error('沒有內容');
  var bytes = Utilities.base64Decode(b64);
  if (bytes.length > 5 * 1024 * 1024) throw new Error('超過 5MB');
  var mime = String(f.mime || 'image/png');
  var ext = (mime.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '').slice(0, 5);
  var name = id + '-' + n + '.' + ext;
  return fbFolder_().createFile(Utilities.newBlob(bytes, mime, name)).getUrl();
}

/** 回饋附件的資料夾。沒設定就自己建一個，並把 ID 記回指令碼屬性，省一道人工設定。 */
function fbFolder_() {
  var id = prop_('FEEDBACK_FOLDER_ID');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) { /* 被刪或沒權限就重建 */ }
  }
  var name = 'JourneyForge 回饋附件';
  var it = DriveApp.getFoldersByName(name);
  var folder = it.hasNext() ? it.next() : DriveApp.createFolder(name);
  PropertiesService.getScriptProperties().setProperty('FEEDBACK_FOLDER_ID', folder.getId());
  return folder;
}

/* ========================= 使用紀錄 ========================= */
/** 前端 logUse() 射後不理送過來的管考資料。 */
function log_(req) {
  var sh = sheet_('使用紀錄', ['時間', '使用者', '動作', '案件ID', '標題', '天數', '站數']);
  sh.appendRow([new Date(), String(req.user || ''), String(req.act || ''),
                String(req.id || ''), String(req.title || ''),
                Number(req.days || 0), Number(req.count || 0)]);
  return { ok: true };
}

/** deep=true 時會真的各打一次 API，才知道金鑰與權限到底有沒有問題 */
function status_(req) {
  var out = { sheet: '', geocode: '', places: '', tdx: prop_('TDX_CLIENT_ID') ? '已設定' : '未設定' };
  try { SpreadsheetApp.openById(prop_('SHEET_ID')); out.sheet = '可讀寫'; }
  catch (e) { out.sheet = '失敗：' + e.message; }

  var key = prop_('MAPS_KEY');
  if (!key) { out.geocode = out.places = '未設定 MAPS_KEY'; return out; }
  if (!req || !req.deep) { out.geocode = out.places = '金鑰已設定（未實測）'; return out; }

  try {
    var g = geocode_(['高雄市左營區高鐵路105號']);
    out.geocode = (g[0] && g[0].lat != null)
      ? ('正常（' + g[0].lat.toFixed(4) + ', ' + g[0].lng.toFixed(4) + '）')
      : '呼叫成功但沒有回傳座標';
  } catch (e) { out.geocode = '失敗：' + e.message; }

  try {
    var pl = placesSearch_(key, 22.6873, 120.3074, { rating: 4, price: 2, radius: 3000 });
    out.places = pl.length ? ('正常，找到 ' + pl.length + ' 家（例：' + pl[0].name + '）')
                           : '呼叫成功但沒有結果';
  } catch (e) { out.places = '失敗：' + e.message; }
  return out;
}

/* ========================= 地址定位 ========================= */
function geocode_(addresses) {
  var sh = sheet_('地點快取', ['地址', '緯度', '經度', '更新時間']);
  var rows = sh.getDataRange().getValues();
  var map = {};
  for (var i = 1; i < rows.length; i++) {
    if (rows[i][0]) map[String(rows[i][0]).trim()] = { lat: rows[i][1], lng: rows[i][2] };
  }

  var key = prop_('MAPS_KEY'), add = [];
  var nCall = 0, nHit = 0;                       // 成本監控用，見「用量」分頁
  var result = addresses.map(function (a) {
    var t = String(a || '').trim();
    if (!t) return { lat: null, lng: null };
    if (map[t]) { nHit++; return map[t]; }
    if (!key) return { lat: null, lng: null };
    nCall++;

    var res = UrlFetchApp.fetch(
      'https://maps.googleapis.com/maps/api/geocode/json?address=' + encodeURIComponent(t)
      + '&region=tw&language=zh-TW&key=' + key, { muteHttpExceptions: true });
    var j = JSON.parse(res.getContentText() || '{}');
    if (j.status !== 'OK' || !j.results || !j.results.length) return { lat: null, lng: null };

    var loc = j.results[0].geometry.location, v = { lat: loc.lat, lng: loc.lng };
    map[t] = v;
    add.push([t, v.lat, v.lng, new Date()]);
    return v;
  });

  if (add.length) sh.getRange(sh.getLastRow() + 1, 1, add.length, 4).setValues(add);
  if (nCall || nHit) bump_({ g: nCall, gh: nHit });
  return result;
}

/* ========================= 午餐搜尋 ========================= */
/**
 * 條件放寬階梯：原條件 → 評分 -0.5 → 半徑 ×1.5 → 不限價位。
 * 偏遠地區搜不到就靠這個逐步鬆綁，而不是直接回空的。
 */
function lunch_(req) {
  var sh = sheet_('餐廳快取',
    ['格號', '名稱', '地址', '緯度', '經度', '評分', '價位', '營業時間JSON', '更新時間']);

  var cell = Math.round(req.lat / GRID) + ',' + Math.round(req.lng / GRID)
    + '|r' + req.minRating + 'p' + req.price;
  var rows = sh.getDataRange().getValues(), hit = [];
  for (var i = 1; i < rows.length; i++) {
    if (rows[i][0] === cell && fresh_(rows[i][8], REST_CACHE_DAYS)) {
      hit.push({ name: rows[i][1], addr: rows[i][2], lat: rows[i][3], lng: rows[i][4],
                 rating: rows[i][5], price: rows[i][6], hours: safeJson_(rows[i][7]) });
    }
  }
  if (hit.length) { bump_({ ph: 1 }); return filterOpen_(hit, req); }

  var key = prop_('MAPS_KEY');
  if (!key) throw new Error('指令碼屬性裡沒有 MAPS_KEY');

  var steps = [
    { rating: req.minRating,       price: req.price, radius: req.radius },
    { rating: req.minRating - 0.5, price: req.price, radius: req.radius },
    { rating: req.minRating - 0.5, price: req.price, radius: req.radius * 1.5 },
    { rating: req.minRating - 0.5, price: 3,         radius: req.radius * 1.5 }
  ];
  var found = [], note = '', tries = 0;
  for (var s = 0; s < steps.length; s++) {
    tries++;
    found = placesSearch_(key, req.lat, req.lng, steps[s]);
    if (found.length) { if (s > 0) note = '已放寬條件'; break; }
  }
  bump_({ p: tries });
  if (!found.length) return [];

  sh.getRange(sh.getLastRow() + 1, 1, found.length, 9).setValues(found.map(function (p) {
    return [cell, p.name, p.addr, p.lat, p.lng, p.rating, p.price,
            JSON.stringify(p.hours || []), new Date()];
  }));

  var out = filterOpen_(found, req);
  if (note) out.forEach(function (o) { o.note = note; });
  return out;
}

function placesSearch_(key, lat, lng, step) {
  var levels = ['PRICE_LEVEL_INEXPENSIVE', 'PRICE_LEVEL_MODERATE', 'PRICE_LEVEL_EXPENSIVE'];
  var body = {
    textQuery: '餐廳', includedType: 'restaurant',
    languageCode: 'zh-TW', regionCode: 'TW', maxResultCount: 20,
    minRating: Math.max(0, step.rating),
    locationBias: { circle: { center: { latitude: lat, longitude: lng }, radius: step.radius } }
  };
  if (step.price < 3) body.priceLevels = levels.slice(0, step.price);

  var res = UrlFetchApp.fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: {
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': ['places.displayName', 'places.formattedAddress', 'places.location',
        'places.rating', 'places.userRatingCount', 'places.priceLevel',
        'places.regularOpeningHours.periods'].join(',')
    },
    payload: JSON.stringify(body)
  });

  var j = JSON.parse(res.getContentText() || '{}');
  if (j.error) throw new Error('Places API：' + (j.error.message || '呼叫失敗'));
  if (!j.places) return [];

  var priceText = { PRICE_LEVEL_INEXPENSIVE: '平價', PRICE_LEVEL_MODERATE: '中等',
                    PRICE_LEVEL_EXPENSIVE: '偏貴', PRICE_LEVEL_VERY_EXPENSIVE: '昂貴' };
  return j.places
    .filter(function (p) { return p.location && (p.userRatingCount || 0) >= 10; })
    .map(function (p) {
      return { name: (p.displayName && p.displayName.text) || '',
               addr: p.formattedAddress || '',
               lat: p.location.latitude, lng: p.location.longitude,
               rating: p.rating || null, price: priceText[p.priceLevel] || '',
               hours: (p.regularOpeningHours && p.regularOpeningHours.periods) || [] };
    });
}

/** 只留當天營業、且營業時段涵蓋用餐時間的；沒有營業資料的一律保留由使用者確認 */
function filterOpen_(list, req) {
  var wd = Number(req.weekday), from = hm_(req.openFrom), to = hm_(req.openTo);
  var ok = list.filter(function (p) {
    if (!p.hours || !p.hours.length) return true;
    return p.hours.some(function (h) {
      if (!h.open || h.open.day !== wd) return false;
      var o = h.open.hour * 60 + (h.open.minute || 0);
      var c = h.close ? (h.close.hour * 60 + (h.close.minute || 0)) : 1440;
      if (c < o) c += 1440;
      return o <= from && c >= to;
    });
  });
  return (ok.length ? ok : list).slice(0, 5);
}

/* ========================= 案件存檔 ========================= */
var CASE_HEADER = ['案件ID', '標題', '日期', '訪視家數', '建立時間', '更新時間', 'Markdown', 'JSON'];

function saveCase_(req) {
  if (!req.id) throw new Error('缺少案件 ID');

  /* 單一儲存格 50,000 字元是 Google 的硬限制，撞上去 setValues 會丟出使用者看不懂的
     原始錯誤。這裡先擋，並且講清楚三件事：多大、上限多少、可以怎麼辦。
     踩到的是使用者、看後台的是管理者，所以這道檢查不能只做在後台。 */
  var json = String(req.json || ''), md = String(req.md || '');
  var big = Math.max(json.length, md.length);
  if (big > CELL_STOP) {
    throw new Error('這份行程太大（' + fmtNum_(big) + ' 字元，單一儲存格上限 '
      + fmtNum_(CELL_MAX) + ' 字元），存不進去。請減少天數或站數，或拆成兩個案件分開存。'
      + '畫面上的行程還在，不會不見，可以先產生 Word 留底再處理。');
  }

  var sh = sheet_('案件', CASE_HEADER);
  var rows = sh.getDataRange().getValues();
  var now = new Date();
  var row = [req.id, req.title || '', req.dates || '', req.count || 0, now, now, md, json];
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(req.id)) {
      row[4] = rows[i][4] || now;                       // 建立時間不覆蓋
      sh.getRange(i + 1, 1, 1, CASE_HEADER.length).setValues([row]);
      return { id: req.id, mode: '更新' };
    }
  }
  sh.appendRow(row);
  return { id: req.id, mode: '新增' };
}

function loadCase_(req) {
  var sh = sheet_('案件', CASE_HEADER);
  var rows = sh.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(req.id)) {
      return { id: rows[i][0], title: rows[i][1], json: String(rows[i][7] || '') };
    }
  }
  throw new Error('找不到這個案件：' + req.id);
}

/** 最近 30 筆，新的在前 */
function listCases_() {
  var sh = sheet_('案件', CASE_HEADER);
  var rows = sh.getDataRange().getValues(), out = [];
  for (var i = rows.length - 1; i >= 1 && out.length < 30; i--) {
    if (!rows[i][0]) continue;
    var u = rows[i][5];
    out.push({
      id: rows[i][0], title: rows[i][1], dates: rows[i][2], count: rows[i][3],
      updated: (u instanceof Date) ? Utilities.formatDate(u, 'Asia/Taipei', 'yyyy-MM-dd HH:mm') : String(u || '')
    });
  }
  return out;
}

/* ========================= 高鐵班表 ========================= */
/** 由北到南的站序，站代碼與欄位順序一致 */
var ST_IDS   = ['0990','1000','1010','1020','1030','1035','1040','1043','1047','1050','1060','1070'];
var ST_NAMES = ['南港','台北','板橋','桃園','新竹','苗栗','台中','彰化','雲林','嘉義','台南','左營'];
var TRAIN_HEADER = ['方向','車次','行駛日'].concat(ST_NAMES).concat(['更新日期']);

/**
 * 前端只會呼叫這支：純粹讀試算表，不連任何外部服務、不花額度。
 * 以停靠矩陣為底，任何兩站的組合都算得出來。
 */
function timetable_(req) {
  var oi = ST_IDS.indexOf(String(req.originId));
  var di = ST_IDS.indexOf(String(req.destId));
  if (oi < 0 || di < 0 || oi === di) throw new Error('起訖站代碼不正確');

  var sh = sheet_('班表', TRAIN_HEADER);
  var rows = sh.getDataRange().getValues();
  var out = [], back = [], updated = '';

  for (var r = 1; r < rows.length; r++) {
    var dir = String(rows[r][0] || '').trim();
    var no  = String(rows[r][1] || '').trim();
    if (!no) continue;

    var southbound = (dir.indexOf('南') >= 0);          // 這班車是南下還是北上
    var goSouth = (oi < di);                             // 去程是不是往南
    var isOut = (southbound === goSouth);                // 這班車算去程還是回程
    var fromIdx = isOut ? oi : di;                       // 這一趟的上車站
    var toIdx   = isOut ? di : oi;
    if (southbound ? (fromIdx >= toIdx) : (fromIdx <= toIdx)) continue;

    var from = cellTimes_(rows[r][3 + fromIdx]);
    var to   = cellTimes_(rows[r][3 + toIdx]);
    if (!from.dep || !to.arr) continue;                  // 有一站不停就不算

    var t = { no: no, dep: from.dep, arr: to.arr, run: parseRun_(rows[r][2]) };
    (isOut ? out : back).push(t);

    var d = rows[r][TRAIN_HEADER.length - 1];
    if (d) {
      var ds = (d instanceof Date) ? Utilities.formatDate(d, 'Asia/Taipei', 'yyyy-MM-dd') : String(d);
      if (ds > updated) updated = ds;
    }
  }
  var bydep = function (x, y) { return x.dep < y.dep ? -1 : 1; };
  return { out: out.sort(bydep), back: back.sort(bydep), updated: updated };
}

/** 「08:26-08:28」拆成到站與開車；只有一個時間就兩者相同；空白代表不停靠 */
function cellTimes_(v) {
  if (v === '' || v == null) return { arr: '', dep: '' };
  if (v instanceof Date) {
    var one = Utilities.formatDate(v, 'Asia/Taipei', 'HH:mm');
    return { arr: one, dep: one };
  }
  var p = String(v).split(/[-–~]/);
  var arr = hhmm_(p[0]), dep = hhmm_(p.length > 1 ? p[1] : p[0]);
  if (!dep) dep = arr;
  if (!arr) arr = dep;
  return { arr: arr, dep: dep };
}

/**
 * 這支請你自己執行，或掛時間驅動觸發程序（建議每月一次）。
 * 從 TDX 抓「定期時刻表」寫進「班表」分頁——例行班表，不含疏運或加班車。
 * 用定期時刻表而不是每日時刻表，是因為後者只有未來約 28 天，當資料庫會過期；
 * 定期時刻表帶有行駛日，任何日期都算得出來。
 */
function refreshTimetable() {
  var token = tdxToken_();
  var gen = tdxGeneral_(token);
  if (!gen.length) throw new Error('TDX 沒有回傳定期時刻表');

  var keys = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  var today = today_();
  var rows = [];

  gen.forEach(function (x) {
    var info = x.GeneralTrainInfo || {};
    var no = String(info.TrainNo || '');
    if (!no) return;

    var run = [];
    var sd = info.ServiceDay || {};
    keys.forEach(function (k, idx) { if (Number(sd[k]) === 1) run.push(idx); });
    if (run.length === 7) run = [];                      // 每日行駛就留空
    if (!run.length && Object.keys(sd).length === 0) run = [];

    var cells = new Array(ST_IDS.length).fill('');
    (x.StopTimes || []).forEach(function (st) {
      var i = ST_IDS.indexOf(String(st.StationID));
      if (i < 0) return;
      var arr = hhmm_(st.ArrivalTime), dep = hhmm_(st.DepartureTime);
      if (!arr && !dep) return;
      cells[i] = (arr && dep && arr !== dep) ? (arr + '-' + dep) : (dep || arr);
    });
    if (!cells.filter(String).length) return;

    var dir = (Number(info.Direction) === 0) ? '南下' : '北上';
    rows.push([dir, no, run.join(',')].concat(cells).concat([today]));
  });

  // 南下依台北或南港時刻排序，北上依左營排序，讀起來順一點
  rows.sort(function (p, q) {
    if (p[0] !== q[0]) return p[0] === '南下' ? -1 : 1;
    var i = p[0] === '南下' ? 3 : 3 + ST_IDS.length - 1;
    return String(p[i] || 'zz') < String(q[i] || 'zz') ? -1 : 1;
  });

  var sh = sheet_('班表', TRAIN_HEADER);
  sh.clear();
  sh.appendRow(TRAIN_HEADER);
  sh.setFrozenRows(1);
  if (rows.length) {
    sh.getRange(2, 1, rows.length, TRAIN_HEADER.length).setValues(rows);
    sh.getRange(2, 3, rows.length, ST_IDS.length + 1).setNumberFormat('@');  // 行駛日與時刻都當文字
  }
  return '已更新例行班表，共 ' + rows.length + ' 班車';
}

function tdxToken_() {
  var id = prop_('TDX_CLIENT_ID'), sec = prop_('TDX_CLIENT_SECRET');
  if (!id || !sec) throw new Error('指令碼屬性裡沒有 TDX_CLIENT_ID / TDX_CLIENT_SECRET');

  var cache = CacheService.getScriptCache(), hit = cache.get('tdx_token');
  if (hit) return hit;

  var res = UrlFetchApp.fetch(
    'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token', {
      method: 'post', muteHttpExceptions: true,
      payload: { grant_type: 'client_credentials', client_id: id, client_secret: sec }
    });
  var j = JSON.parse(res.getContentText() || '{}');
  if (!j.access_token) throw new Error('TDX 取權杖失敗：' + (j.error_description || j.error || '未知原因'));
  cache.put('tdx_token', j.access_token, Math.min(21600, (j.expires_in || 3600) - 120));
  return j.access_token;
}

/** 定期時刻表：所有車次的每站停靠時間與行駛日 */
function tdxGeneral_(token) {
  var res = UrlFetchApp.fetch(
    'https://tdx.transportdata.tw/api/basic/v2/Rail/THSR/GeneralTimetable?$format=JSON', {
      muteHttpExceptions: true,
      headers: { authorization: 'Bearer ' + token, 'Accept-Encoding': 'gzip' }
    });
  if (res.getResponseCode() >= 400) throw new Error('TDX 回應 ' + res.getResponseCode());
  try { return JSON.parse(res.getContentText()) || []; } catch (e) { return []; }
}

function parseRun_(v) {
  if (v === '' || v == null) return [];
  return String(v).split(/[,、\s]+/).map(Number).filter(function (n) { return n >= 0 && n <= 6; });
}

/* ========================= 小工具 ========================= */
function hhmm_(s) {
  if (!s) return '';
  // 手動貼進試算表時，06:30 可能被自動轉成時間值，這裡一併處理
  if (s instanceof Date) return Utilities.formatDate(s, 'Asia/Taipei', 'HH:mm');
  var m = String(s).match(/(\d{1,2}):(\d{2})/);
  return m ? (('0' + m[1]).slice(-2) + ':' + m[2]) : '';
}
function hm_(s) {
  var p = String(s || '12:00').split(':');
  return (Number(p[0]) || 0) * 60 + (Number(p[1]) || 0);
}
function safeJson_(s) {
  try { return JSON.parse(s || '{}'); } catch (e) { return {}; }
}

/* ==========================================================================
   後台（admin.html 專用）
   --------------------------------------------------------------------------
   後台走的是另一組帳密，不吃 ACCESS_KEY。理由：ACCESS_KEY 是發給全體使用者的，
   拿得到工具就拿得到它；後台看得到所有人的使用紀錄與回饋內容，不能同一把鑰匙。

   第一次啟用：在 Apps Script 編輯器手動執行一次
       setAdmin('帳號', '至少十碼的密碼')
   跑完把引數改回空字串再存檔，密碼不要留在程式碼裡。指令碼屬性只存
   ADMIN_USER / ADMIN_SALT / ADMIN_HASH（SHA-256(salt:密碼)），不存明碼。

   登入成功發一組 token 放 CacheService，六小時後自動失效（CacheService 上限就是
   六小時，不要試圖設更長）。連續錯 5 次鎖 15 分鐘。
   ========================================================================== */

var ADMIN_API   = '1.1';
var ADMIN_TTL   = 21600;   // token 有效秒數，CacheService 上限六小時
var ADMIN_FAIL  = 5;       // 連續失敗幾次上鎖
var ADMIN_LOCK  = 15;      // 上鎖幾分鐘

/* 單價（美金／次）。Google 調價時改這兩行，後台的估算費用跟著動。 */
var PRICE_GEOCODE = 0.005;
var PRICE_PLACES  = 0.032;

var ERR_HEADER   = ['時間', '使用者', '版本', '來源', '動作', '訊息', '詳細', '環境', '狀態'];
var USAGE_HEADER = ['日期', 'geocode呼叫', 'geocode快取命中', 'places呼叫', 'places快取命中'];

/** 在編輯器手動執行，設定後台帳密。回傳字串會出現在執行紀錄。 */
function setAdmin(user, pass) {
  if (!user || !pass) throw new Error('用法：setAdmin("帳號", "密碼")');
  if (String(pass).length < 10) throw new Error('密碼至少 10 個字元');
  var salt = Utilities.getUuid();
  PropertiesService.getScriptProperties().setProperties({
    ADMIN_USER: String(user),
    ADMIN_SALT: salt,
    ADMIN_HASH: sha256_(salt + ':' + String(pass))
  });
  return '已設定管理者：' + user + '（請把這次執行的引數清空再存檔）';
}

function sha256_(s) {
  var b = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8);
  var out = '';
  for (var i = 0; i < b.length; i++) out += ('0' + (b[i] & 0xFF).toString(16)).slice(-2);
  return out;
}

/* ========================= 登入 ========================= */
function adminLogin_(req) {
  var c    = CacheService.getScriptCache();
  var who  = String(req.user || '').trim();
  var lock = 'adminlock_' + who;
  if (c.get(lock)) throw new Error('嘗試次數過多，請 ' + ADMIN_LOCK + ' 分鐘後再試');

  var u = prop_('ADMIN_USER'), h = prop_('ADMIN_HASH'), s = prop_('ADMIN_SALT');
  if (!u || !h) throw new Error('後端還沒設定管理者帳密：請先在 Apps Script 執行 setAdmin()');

  if (who !== u || sha256_(s + ':' + String(req.pass || '')) !== h) {
    var fk = 'adminfail_' + who;
    var n  = Number(c.get(fk) || 0) + 1;
    c.put(fk, String(n), ADMIN_LOCK * 60);
    if (n >= ADMIN_FAIL) c.put(lock, '1', ADMIN_LOCK * 60);
    Utilities.sleep(700);                       // 拖慢連續嘗試
    throw new Error('帳號或密碼不正確');
  }

  c.remove('adminfail_' + who);
  var tk = Utilities.getUuid().replace(/-/g, '');
  c.put('admintk_' + tk, who, ADMIN_TTL);
  return { token: tk, user: who, ttl: ADMIN_TTL, api: ADMIN_API };
}

function adminWho_(req) {
  var tk  = String(req.token || '');
  var who = tk ? CacheService.getScriptCache().get('admintk_' + tk) : null;
  if (!who) throw new Error('登入已逾期，請重新登入');
  return who;
}

/* ========================= 路由 ========================= */
function admin_(req) {
  if (req.action === 'adminLogin') return adminLogin_(req);
  var who = adminWho_(req);
  switch (req.action) {
    case 'adminPing':        return { user: who, api: ADMIN_API };
    case 'adminLogout':      CacheService.getScriptCache().remove('admintk_' + req.token); return { ok: true };
    case 'adminOverview':    return adminOverview_(req);
    case 'adminFeedback':    return adminFeedback_(req);
    case 'adminFeedbackSet': return adminFeedbackSet_(req, who);
    case 'adminCases':       return adminCases_(req);
    case 'adminCase':        return adminCase_(req);
    case 'adminErrors':      return adminErrors_(req);
    case 'adminErrorSet':    return adminErrorSet_(req, who);
    case 'adminHealth':      return adminHealth_(req);
    case 'adminCost':        return adminCost_(req);
    case 'adminOps':         return adminOps_(req);
    case 'adminClean':       return adminClean_(req, who);
  }
  throw new Error('不認得的 action：' + req.action);
}

/* ========================= 共用小工具 ========================= */
function ymd_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Taipei', 'yyyy-MM-dd');
  return String(v || '').slice(0, 10);
}
function stamp_(v) {
  return (v instanceof Date) ? Utilities.formatDate(v, 'Asia/Taipei', 'yyyy-MM-dd HH:mm') : String(v || '');
}
function dayBack_(n) {
  var d = new Date(); d.setDate(d.getDate() - n);
  return Utilities.formatDate(d, 'Asia/Taipei', 'yyyy-MM-dd');
}
/** 分頁少了某一欄就補在最後面，不動既有資料。 */
function ensureCol_(sh, name) {
  var last = sh.getLastColumn();
  var head = sh.getRange(1, 1, 1, last).getValues()[0];
  for (var i = 0; i < head.length; i++) if (String(head[i]).trim() === name) return i + 1;
  sh.getRange(1, last + 1).setValue(name);
  return last + 1;
}
/** 整張分頁讀成陣列，空分頁回 [[header]]。 */
function allRows_(name, header) {
  var sh = sheet_(name, header);
  if (sh.getLastRow() < 1) return { sh: sh, rows: [header] };
  return { sh: sh, rows: sh.getDataRange().getValues() };
}

/* ========================= 使用量計數 =========================
   geocode_ 與 lunch_ 每次呼叫收尾時各記一筆，一天一列。
   寫失敗一律吞掉——管考資料再重要，也不該讓使用者的排程失敗。         */
function bump_(add) {
  try {
    var sh   = sheet_('用量', USAGE_HEADER);
    var day  = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd');
    var rows = sh.getDataRange().getValues();
    var idx  = { g: 1, gh: 2, p: 3, ph: 4 };
    for (var i = rows.length - 1; i >= 1; i--) {
      if (ymd_(rows[i][0]) === day) {
        var cur = [rows[i][1] || 0, rows[i][2] || 0, rows[i][3] || 0, rows[i][4] || 0];
        for (var k in add) if (idx[k] != null) cur[idx[k] - 1] = Number(cur[idx[k] - 1]) + Number(add[k] || 0);
        sh.getRange(i + 1, 2, 1, 4).setValues([cur]);
        return;
      }
    }
    var row = [day, 0, 0, 0, 0];
    for (var k2 in add) if (idx[k2] != null) row[idx[k2]] = Number(add[k2] || 0);
    sh.appendRow(row);
  } catch (e) { /* 靜默 */ }
}

/* ========================= 錯誤回報 =========================
   前端 reportErr() 送過來。踩過的坑第 5 條：射後不理的呼叫壞掉沒人知道，
   所以這支有回傳值，前端送不出去會先存在 localStorage，下次補送。       */
function err_(req) {
  var sh = sheet_('錯誤', ERR_HEADER);
  sh.appendRow([
    new Date(), String(req.user || ''), String(req.app || ''),
    String(req.src || ''), String(req.act || ''),
    String(req.msg || '').slice(0, 500),
    String(req.detail || '').slice(0, 2000),
    req.env ? JSON.stringify(req.env) : '', '新'
  ]);
  return { ok: true };
}

/* ========================= 總覽與使用分析 ========================= */
function adminOverview_(req) {
  var days  = Math.max(1, Math.min(365, Number(req.days || 30)));
  var from  = dayBack_(days - 1);
  var d     = allRows_('使用紀錄', ['時間', '使用者', '動作', '案件ID', '標題', '天數', '站數']);
  var rows  = d.rows;

  var daily = {}, byAct = {}, byUser = {}, byDow = [0,0,0,0,0,0,0], byHour = [];
  for (var h = 0; h < 24; h++) byHour.push(0);
  var recent = [], total = 0, out = 0, sumDays = 0, sumStops = 0, planN = 0, maxStops = 0;

  for (var i = 1; i < rows.length; i++) {
    var t = rows[i][0]; if (!t) continue;
    var day = ymd_(t);
    if (day < from) continue;

    var user = String(rows[i][1] || '（未填名字）');
    var act  = String(rows[i][2] || '其他');
    total++;
    daily[day] = daily[day] || {};
    daily[day][act] = (daily[day][act] || 0) + 1;
    byAct[act] = (byAct[act] || 0) + 1;

    var u = byUser[user] || (byUser[user] = { user: user, runs: 0, outputs: 0, cases: {}, last: '' });
    if (act === '規劃行程') u.runs++;
    if (act === '產生Word' || act === '列印') { u.outputs++; out++; }
    if (rows[i][3]) u.cases[String(rows[i][3])] = 1;
    var st = stamp_(t); if (st > u.last) u.last = st;

    if (t instanceof Date) { byDow[t.getDay()]++; byHour[t.getHours()]++; }

    if (act === '規劃行程') {
      planN++;
      sumDays  += Number(rows[i][5] || 0);
      sumStops += Number(rows[i][6] || 0);
      if (Number(rows[i][6] || 0) > maxStops) maxStops = Number(rows[i][6]);
    }
    recent.push({ time: st, user: user, act: act, id: String(rows[i][3] || ''), title: String(rows[i][4] || ''),
                  days: Number(rows[i][5] || 0), stops: Number(rows[i][6] || 0) });
  }
  recent = recent.slice(-40).reverse();

  var series = [];
  for (var k = 0; k < days; k++) {
    var dd = dayBack_(days - 1 - k);
    series.push({ d: dd, v: daily[dd] || {} });
  }

  var users = [];
  for (var uk in byUser) {
    byUser[uk].cases = Object.keys(byUser[uk].cases).length;
    users.push(byUser[uk]);
  }
  users.sort(function (a, b) { return (b.runs + b.outputs) - (a.runs + a.outputs); });

  var acts = [];
  for (var ak in byAct) acts.push({ act: ak, n: byAct[ak] });
  acts.sort(function (a, b) { return b.n - a.n; });

  /* 回饋與錯誤的摘要，總覽的燈號用得到 */
  var fb = allRows_('回饋', ['收件編號', '時間', '使用者', '版本', '分類', '滿意度',
                             '內容', '附件', '環境', '狀態', '處理備註']).rows;
  var fbStat = {}, fbOpen = 0, rateSum = 0, rateN = 0, fbNew = 0;
  for (var f = 1; f < fb.length; f++) {
    if (!fb[f][0]) continue;
    var stt = String(fb[f][9] || '待處理');
    fbStat[stt] = (fbStat[stt] || 0) + 1;
    if (stt === '待處理' || stt === '處理中') fbOpen++;
    var r = parseFloat(String(fb[f][5] || '')); if (r) { rateSum += r; rateN++; }
    if (ymd_(fb[f][1]) >= from) fbNew++;
  }

  var er = allRows_('錯誤', ERR_HEADER).rows;
  var err7 = 0, errOpen = 0, from7 = dayBack_(6);
  for (var e = 1; e < er.length; e++) {
    if (!er[e][0]) continue;
    if (ymd_(er[e][0]) >= from7) err7++;
    if (String(er[e][8] || '新') === '新') errOpen++;
  }

  var cs = allRows_('案件', CASE_HEADER).rows;
  var caseTotal = 0, caseNew = 0;
  for (var c = 1; c < cs.length; c++) {
    if (!cs[c][0]) continue;
    caseTotal++;
    if (ymd_(cs[c][4]) >= from) caseNew++;
  }

  return {
    days: days, from: from, to: dayBack_(0),
    kpi: {
      total: total, plans: byAct['規劃行程'] || 0, outputs: out,
      users: users.length, caseNew: caseNew, caseTotal: caseTotal,
      fbOpen: fbOpen, fbNew: fbNew, err7: err7, errOpen: errOpen,
      avgDays: planN ? Math.round(sumDays / planN * 10) / 10 : 0,
      avgStops: planN ? Math.round(sumStops / planN * 10) / 10 : 0,
      maxStops: maxStops,
      rate: rateN ? Math.round(rateSum / rateN * 10) / 10 : 0, rateN: rateN
    },
    series: series, users: users, acts: acts, dow: byDow, hour: byHour,
    recent: recent, fbStat: fbStat,
    /* 案件分頁上面已經整張讀過了（cs），這裡是白撿的。不量讀取耗時——
       總覽不該為了一條橫幅多付一次整張讀的成本，那一項留給「資料維運」。 */
    health: (function () {
      var h = storageHealth_(SpreadsheetApp.openById(prop_('SHEET_ID')), cs, null);
      return { level: h.level, alerts: h.alerts };
    })()
  };
}

/* ========================= 回饋 ========================= */
var FB_HEADER = ['收件編號', '時間', '使用者', '版本', '分類', '滿意度',
                 '內容', '附件', '環境', '狀態', '處理備註'];

function adminFeedback_(req) {
  var d = allRows_('回饋', FB_HEADER), rows = d.rows;
  var colTrack = ensureCol_(d.sh, '追蹤編號');
  var colBy    = ensureCol_(d.sh, '處理人');
  var colAt    = ensureCol_(d.sh, '處理時間');
  var out = [];
  for (var i = rows.length - 1; i >= 1; i--) {
    if (!rows[i][0]) continue;
    var st  = String(rows[i][9] || '待處理');
    var cat = String(rows[i][4] || '');
    if (req.status && req.status !== '全部' && st !== req.status) continue;
    if (req.cat && req.cat !== '全部' && cat !== req.cat) continue;
    if (req.q && (String(rows[i][6]) + rows[i][2] + rows[i][0]).indexOf(req.q) < 0) continue;
    out.push({
      row: i + 1, id: rows[i][0], time: stamp_(rows[i][1]), user: String(rows[i][2] || ''),
      app: String(rows[i][3] || ''), cat: cat, rate: String(rows[i][5] || ''),
      text: String(rows[i][6] || ''), files: String(rows[i][7] || ''),
      env: String(rows[i][8] || ''), status: st, note: String(rows[i][10] || ''),
      track: String(rows[i][colTrack - 1] || ''), by: String(rows[i][colBy - 1] || ''),
      at: stamp_(rows[i][colAt - 1])
    });
    if (out.length >= 300) break;
  }
  return { list: out, cols: { track: colTrack, by: colBy, at: colAt } };
}

function adminFeedbackSet_(req, who) {
  var d = allRows_('回饋', FB_HEADER), rows = d.rows;
  var colTrack = ensureCol_(d.sh, '追蹤編號');
  var colBy    = ensureCol_(d.sh, '處理人');
  var colAt    = ensureCol_(d.sh, '處理時間');
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) !== String(req.id)) continue;
    if (req.status != null) d.sh.getRange(i + 1, 10).setValue(String(req.status));
    if (req.note   != null) d.sh.getRange(i + 1, 11).setValue(String(req.note));
    if (req.track  != null) d.sh.getRange(i + 1, colTrack).setValue(String(req.track));
    d.sh.getRange(i + 1, colBy).setValue(who);
    d.sh.getRange(i + 1, colAt).setValue(new Date());
    return { ok: true, id: req.id };
  }
  throw new Error('找不到收件編號 ' + req.id);
}

/* ========================= 案件 ========================= */
function adminCases_(req) {
  var rows = allRows_('案件', CASE_HEADER).rows;
  var q = String(req.q || '').trim();
  var out = [];
  for (var i = rows.length - 1; i >= 1; i--) {
    if (!rows[i][0]) continue;
    var hay = [rows[i][0], rows[i][1], rows[i][2]].join(' ');
    if (q && hay.indexOf(q) < 0) continue;
    out.push({
      id: String(rows[i][0]), title: String(rows[i][1] || ''), dates: String(rows[i][2] || ''),
      count: Number(rows[i][3] || 0), created: stamp_(rows[i][4]), updated: stamp_(rows[i][5]),
      bytes: String(rows[i][7] || '').length
    });
    if (out.length >= 400) break;
  }
  return { list: out };
}

function adminCase_(req) {
  var rows = allRows_('案件', CASE_HEADER).rows;
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(req.id)) {
      return { id: rows[i][0], title: String(rows[i][1] || ''), dates: String(rows[i][2] || ''),
               count: Number(rows[i][3] || 0), created: stamp_(rows[i][4]),
               updated: stamp_(rows[i][5]), md: String(rows[i][6] || '') };
    }
  }
  throw new Error('找不到案件 ' + req.id);
}

/* ========================= 錯誤 ========================= */
function adminErrors_(req) {
  var rows = allRows_('錯誤', ERR_HEADER).rows;
  var from = dayBack_(Math.max(1, Math.min(365, Number(req.days || 30))) - 1);
  var list = [], group = {};
  for (var i = rows.length - 1; i >= 1; i--) {
    if (!rows[i][0]) continue;
    if (ymd_(rows[i][0]) < from) continue;
    var st = String(rows[i][8] || '新');
    if (req.status && req.status !== '全部' && st !== req.status) continue;
    var msg = String(rows[i][5] || '');
    var g = group[msg] || (group[msg] = { msg: msg, n: 0, last: '', users: {} });
    g.n++; g.users[String(rows[i][1] || '')] = 1;
    var s = stamp_(rows[i][0]); if (s > g.last) g.last = s;
    if (list.length < 300) {
      list.push({ row: i + 1, time: s, user: String(rows[i][1] || ''), app: String(rows[i][2] || ''),
                  src: String(rows[i][3] || ''), act: String(rows[i][4] || ''), msg: msg,
                  detail: String(rows[i][6] || ''), env: String(rows[i][7] || ''), status: st });
    }
  }
  var groups = [];
  for (var k in group) { group[k].users = Object.keys(group[k].users).length; groups.push(group[k]); }
  groups.sort(function (a, b) { return b.n - a.n; });
  return { list: list, groups: groups.slice(0, 30) };
}

function adminErrorSet_(req, who) {
  var d = allRows_('錯誤', ERR_HEADER);
  var r = Number(req.row || 0);
  if (r < 2 || r > d.sh.getLastRow()) throw new Error('列號不正確');
  d.sh.getRange(r, 9).setValue(String(req.status || '已處理') + '（' + who + '）');
  return { ok: true };
}

/* ========================= 健康檢查 ========================= */
function adminHealth_(req) {
  var out = { checked: stamp_(new Date()), items: [] };
  function add(name, ok, note) { out.items.push({ name: name, ok: ok, note: note }); }

  try {
    var ss = SpreadsheetApp.openById(prop_('SHEET_ID'));
    add('試算表', 'ok', ss.getName());
  } catch (e) { add('試算表', 'bad', e.message); }

  add('ACCESS_KEY', prop_('ACCESS_KEY') ? (String(prop_('ACCESS_KEY')).length >= 16 ? 'ok' : 'warn') : 'bad',
      prop_('ACCESS_KEY') ? ('已設定，' + String(prop_('ACCESS_KEY')).length + ' 字元'
                             + (String(prop_('ACCESS_KEY')).length < 16 ? '（建議 16 字元以上）' : ''))
                          : '未設定，等於不設防');

  var key = prop_('MAPS_KEY');
  if (!key) { add('Geocoding API', 'warn', '未設定 MAPS_KEY，只能縣市層級定位');
              add('Places API', 'warn', '未設定 MAPS_KEY，午餐只能放待訂'); }
  else {
    try {
      var g = geocode_(['高雄市左營區高鐵路105號']);
      add('Geocoding API', (g[0] && g[0].lat != null) ? 'ok' : 'warn',
          (g[0] && g[0].lat != null) ? ('正常（' + g[0].lat.toFixed(4) + ', ' + g[0].lng.toFixed(4) + '）') : '呼叫成功但沒有座標');
    } catch (e2) { add('Geocoding API', 'bad', e2.message); }
    try {
      var pl = placesSearch_(key, 22.6873, 120.3074, { rating: 4, price: 2, radius: 3000 });
      add('Places API', pl.length ? 'ok' : 'warn', pl.length ? ('正常，找到 ' + pl.length + ' 家') : '呼叫成功但沒有結果');
    } catch (e3) { add('Places API', 'bad', e3.message); }
  }

  add('TDX 金鑰', prop_('TDX_CLIENT_ID') ? 'ok' : 'warn',
      prop_('TDX_CLIENT_ID') ? '已設定，可跑 refreshTimetable()' : '未設定，班表需人工匯入');
  add('回饋附件資料夾', prop_('FEEDBACK_FOLDER_ID') ? 'ok' : 'warn',
      prop_('FEEDBACK_FOLDER_ID') ? '已建立' : '尚未建立（第一次有人貼截圖時自動建）');
  return out;
}

/* ========================= 成本與配額 ========================= */
function adminCost_(req) {
  var days = Math.max(1, Math.min(365, Number(req.days || 30)));
  var from = dayBack_(days - 1);
  var rows = allRows_('用量', USAGE_HEADER).rows;
  var map = {};
  for (var i = 1; i < rows.length; i++) {
    var d = ymd_(rows[i][0]); if (!d || d < from) continue;
    map[d] = { g: Number(rows[i][1] || 0), gh: Number(rows[i][2] || 0),
               p: Number(rows[i][3] || 0), ph: Number(rows[i][4] || 0) };
  }
  var series = [], sum = { g: 0, gh: 0, p: 0, ph: 0 };
  for (var k = 0; k < days; k++) {
    var dd = dayBack_(days - 1 - k);
    var v = map[dd] || { g: 0, gh: 0, p: 0, ph: 0 };
    series.push({ d: dd, g: v.g, gh: v.gh, p: v.p, ph: v.ph });
    sum.g += v.g; sum.gh += v.gh; sum.p += v.p; sum.ph += v.ph;
  }
  var geoCache = allRows_('地點快取', ['地址', '緯度', '經度', '更新時間']).rows.length - 1;
  var restRows = allRows_('餐廳快取',
    ['格號', '名稱', '地址', '緯度', '經度', '評分', '價位', '營業時間JSON', '更新時間']).rows;
  var restStale = 0;
  for (var r = 1; r < restRows.length; r++) if (restRows[r][0] && !fresh_(restRows[r][8], REST_CACHE_DAYS)) restStale++;

  return {
    days: days, series: series, sum: sum,
    price: { geocode: PRICE_GEOCODE, places: PRICE_PLACES },
    cost: Math.round((sum.g * PRICE_GEOCODE + sum.p * PRICE_PLACES) * 100) / 100,
    saved: Math.round((sum.gh * PRICE_GEOCODE + sum.ph * PRICE_PLACES) * 100) / 100,
    cache: { geo: Math.max(0, geoCache), rest: Math.max(0, restRows.length - 1), restStale: restStale }
  };
}

/* ========================= 儲存健康度 =========================
   四個指標，各自回一個帶 level（ok／warn／bad）的項目，後台照 level 決定燈號。
   每一項都帶一句 fix ——「燈亮了要幹嘛」必須跟燈號放在一起，因為三個月後
   看到紅燈的人不會是現在寫這段的人。門檻在檔案開頭的常數區。          */

function fmtNum_(n) {
  return String(Math.round(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function level_(v, warn, stop) {
  return v >= stop ? 'bad' : (v >= warn ? 'warn' : 'ok');
}
function worst_(items) {
  var rank = { ok: 0, warn: 1, bad: 2 }, out = 'ok';
  for (var i = 0; i < items.length; i++) if (rank[items[i].level] > rank[out]) out = items[i].level;
  return out;
}

/**
 * 儲存健康度。
 * @param {Spreadsheet} ss       已經開好的試算表
 * @param {Array}       rows     「案件」分頁 getValues() 的結果。呼叫端本來就讀過了就傳進來，
 *                               不要為了這支再讀一次——整張讀正是我們要量的成本。
 * @param {number|null} scanMs   讀那張表花了幾毫秒。沒量就傳 null，該項標成未量測。
 */
function storageHealth_(ss, rows, scanMs) {
  var items = [], alerts = [], i;

  /* 1) 總格數。算的是「配置出來的格子」（maxRows × maxColumns），不是填了字的格子——
        Google 的 1,000 萬上限也是照這個算，所以分頁右下角沒用到的空白列一樣佔額度。 */
  var all = ss.getSheets(), cells = 0, per = [];
  for (i = 0; i < all.length; i++) {
    var n = all[i].getMaxRows() * all[i].getMaxColumns();
    cells += n;
    per.push({ name: all[i].getName(), cells: n });
  }
  per.sort(function (a, b) { return b.cells - a.cells; });
  items.push({
    key: 'cells', name: '試算表總格數',
    display: fmtNum_(cells) + ' ／ ' + fmtNum_(CELLS_MAX) + ' 格',
    pct: Math.round(cells / CELLS_MAX * 1000) / 10,
    level: level_(cells, CELLS_WARN, CELLS_STOP),
    note: per.length ? ('最大的分頁是「' + per[0].name + '」，' + fmtNum_(per[0].cells) + ' 格') : '',
    fix: '把去年的「使用紀錄」與「錯誤」搬到另一份試算表封存，並刪掉各分頁下方沒用到的空白列（空列一樣算格數）。這個上限爆掉是整份試算表一起死，回饋與使用紀錄也會一起寫不進去。'
  });

  /* 2) 最大的一份案件 JSON。順便統計平均、逼近門檻的件數、近 30 天新增。 */
  var maxLen = 0, maxId = '', sumLen = 0, cnt = 0, near = 0, new30 = 0;
  var from30 = dayBack_(30);
  rows = rows || [];
  for (i = 1; i < rows.length; i++) {
    if (!rows[i][0]) continue;
    cnt++;
    var L = String(rows[i][7] || '').length;
    sumLen += L;
    if (L >= CELL_WARN) near++;
    if (L > maxLen) { maxLen = L; maxId = String(rows[i][0]); }
    if (ymd_(rows[i][4]) >= from30) new30++;
  }
  items.push({
    key: 'cell', name: '最大的案件 JSON',
    display: fmtNum_(maxLen) + ' ／ ' + fmtNum_(CELL_MAX) + ' 字元',
    pct: Math.round(maxLen / CELL_MAX * 1000) / 10,
    level: level_(maxLen, CELL_WARN, CELL_STOP),
    note: (maxId ? ('案件 ' + maxId + '；') : '') + '平均 ' + fmtNum_(cnt ? sumLen / cnt : 0)
          + ' 字元，' + near + ' 件已超過 ' + fmtNum_(CELL_WARN) + ' 字元',
    fix: '單一儲存格 50,000 字元是 Google 的硬限制。到紅燈就該把 JSON 改存成雲端硬碟上的檔案、試算表只留 fileId；在那之前，saveCase_ 會在 '
         + fmtNum_(CELL_STOP) + ' 字元擋下來並請使用者拆成兩個案件。'
  });

  /* 3) 整張讀進來要多久。saveCase_ 與 loadCase_ 每次都做這件事，
        所以這個數字比列數誠實——慢的是使用者，不是後台。 */
  items.push({
    key: 'scan', name: '案件分頁讀取耗時',
    display: (scanMs === null || scanMs === undefined) ? '未量測' : (fmtNum_(scanMs) + ' ms'),
    pct: (scanMs === null || scanMs === undefined) ? 0 : Math.round(scanMs / SCAN_STOP_MS * 1000) / 10,
    level: (scanMs === null || scanMs === undefined) ? 'ok' : level_(scanMs, SCAN_WARN_MS, SCAN_STOP_MS),
    note: (scanMs === null || scanMs === undefined) ? '這一頁沒有量，開「資料維運」才會量'
          : ('存檔與開啟案件每次都要付這個成本，門檻 ' + fmtNum_(SCAN_WARN_MS) + ' ／ ' + fmtNum_(SCAN_STOP_MS) + ' ms'),
    fix: 'saveCase_ 與 loadCase_ 改用 createTextFinder(id) 找列號，不要 getDataRange().getValues() 整張讀。改完這兩支，列數再多也不影響存取。'
  });

  /* 4) 案件列數，以及照近 30 天的速度還能撐多久。 */
  var perDay = new30 / 30, months = '';
  if (cnt >= CASE_ROW_STOP) months = '已超過';
  else if (perDay > 0) months = '照近 30 天的速度約 ' + Math.round((CASE_ROW_STOP - cnt) / perDay / 30) + ' 個月後到紅線';
  else months = '近 30 天沒有新案件';
  items.push({
    key: 'rows', name: '案件筆數',
    display: fmtNum_(cnt) + ' 件',
    pct: Math.round(cnt / CASE_ROW_STOP * 1000) / 10,
    level: level_(cnt, CASE_ROW_WARN, CASE_ROW_STOP),
    note: '近 30 天新增 ' + new30 + ' 件；' + months,
    fix: '跟上一項同一個解法（改用 TextFinder）。真的很多的話再依年度拆成「案件2026」「案件2027」分頁。'
  });

  for (i = 0; i < items.length; i++) {
    if (items[i].level === 'bad') alerts.push(items[i].name + '：' + items[i].display);
  }
  return {
    level: worst_(items), items: items, alerts: alerts,
    cases: { count: cnt, avg: Math.round(cnt ? sumLen / cnt : 0), near: near, new30: new30 },
    top: per.slice(0, 5)
  };
}

/** 近 30 天新增列數。只讀日期那一欄，不要整張讀。 */
function growth_(ss) {
  var want = [['案件', 5], ['使用紀錄', 1], ['錯誤', 1], ['回饋', 2], ['用量', 1]];
  var from = dayBack_(30), from7 = dayBack_(7), out = [];
  for (var i = 0; i < want.length; i++) {
    var sh = ss.getSheetByName(want[i][0]);
    if (!sh || sh.getLastRow() < 2) { out.push({ name: want[i][0], rows: 0, d30: 0, d7: 0 }); continue; }
    var vals = sh.getRange(2, want[i][1], sh.getLastRow() - 1, 1).getValues();
    var d30 = 0, d7 = 0;
    for (var r = 0; r < vals.length; r++) {
      var d = ymd_(vals[r][0]);
      if (!d) continue;
      if (d >= from) d30++;
      if (d >= from7) d7++;
    }
    out.push({ name: want[i][0], rows: vals.length, d30: d30, d7: d7 });
  }
  return out;
}

/* ========================= 資料維運 ========================= */
function adminOps_(req) {
  var ss = SpreadsheetApp.openById(prop_('SHEET_ID'));
  var want = ['班表', '地點快取', '餐廳快取', '案件', '使用紀錄', '回饋', '錯誤', '用量'];
  var tabs = [];
  for (var i = 0; i < want.length; i++) {
    var sh = ss.getSheetByName(want[i]);
    tabs.push({ name: want[i], exists: !!sh, rows: sh ? Math.max(0, sh.getLastRow() - 1) : 0,
                cols: sh ? sh.getLastColumn() : 0 });
  }

  /* 案件分頁整張讀一次，順便量時間——這正是 saveCase_／loadCase_ 每次付的成本。
     讀回來的 rows 直接餵給 storageHealth_，不要讓它再讀第二次。 */
  var t0 = new Date().getTime();
  var csh = ss.getSheetByName('案件');
  var caseRows = csh && csh.getLastRow() > 0 ? csh.getDataRange().getValues() : [];
  var scanMs = new Date().getTime() - t0;

  var tt = { rows: 0, updated: '', daily: 0, limited: 0 };
  var tsh = ss.getSheetByName('班表');
  if (tsh && tsh.getLastRow() > 1) {
    var tr = tsh.getDataRange().getValues();
    tt.rows = tr.length - 1;
    for (var t = 1; t < tr.length; t++) {
      var run = String(tr[t][2] || '').trim();
      if (run) tt.limited++; else tt.daily++;
      var up = stamp_(tr[t][tr[t].length - 1]);
      if (up && up > tt.updated) tt.updated = up;
    }
  }

  return {
    sheet: { id: prop_('SHEET_ID'), name: ss.getName(), url: ss.getUrl() },
    tabs: tabs, timetable: tt,
    health: storageHealth_(ss, caseRows, scanMs),
    growth: growth_(ss),
    limits: { cellMax: CELL_MAX, cellWarn: CELL_WARN, cellStop: CELL_STOP,
              cellsMax: CELLS_MAX, cellsWarn: CELLS_WARN, cellsStop: CELLS_STOP,
              scanWarn: SCAN_WARN_MS, scanStop: SCAN_STOP_MS,
              rowWarn: CASE_ROW_WARN, rowStop: CASE_ROW_STOP },
    props: {
      ACCESS_KEY: prop_('ACCESS_KEY') ? String(prop_('ACCESS_KEY')).length + ' 字元' : '未設定',
      MAPS_KEY: prop_('MAPS_KEY') ? '已設定' : '未設定',
      TDX: prop_('TDX_CLIENT_ID') ? '已設定' : '未設定',
      FEEDBACK_FOLDER_ID: prop_('FEEDBACK_FOLDER_ID') ? '已建立' : '尚未建立',
      ADMIN_USER: prop_('ADMIN_USER') || '未設定'
    },
    api: ADMIN_API,
    cacheDays: REST_CACHE_DAYS
  };
}

/** 只清快取，不碰回饋與使用紀錄——那兩張的收件編號與稽核價值靠列數撐著。 */
function adminClean_(req, who) {
  var what = String(req.what || '');
  if (what === 'restStale') {
    var sh = sheet_('餐廳快取',
      ['格號', '名稱', '地址', '緯度', '經度', '評分', '價位', '營業時間JSON', '更新時間']);
    var rows = sh.getDataRange().getValues(), del = 0;
    for (var i = rows.length - 1; i >= 1; i--) {
      if (rows[i][0] && !fresh_(rows[i][8], REST_CACHE_DAYS)) { sh.deleteRow(i + 1); del++; }
    }
    return { ok: true, deleted: del, what: '過期餐廳快取' };
  }
  if (what === 'geoAll') {
    var g = sheet_('地點快取', ['地址', '緯度', '經度', '更新時間']);
    var n = Math.max(0, g.getLastRow() - 1);
    if (n) g.deleteRows(2, n);
    return { ok: true, deleted: n, what: '地點快取（下次查詢會重打 Geocoding）' };
  }
  throw new Error('不支援的清理項目：' + what);
}
