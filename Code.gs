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
 *
 * 高鐵班表怎麼更新：使用者端不會呼叫 TDX，只會讀試算表。
 * 由你在 Apps Script 編輯器手動執行 refreshTimetable()，或設一個「時間驅動」觸發程序
 * （例如每月一次）自動跑。跑完「班表」分頁就是最新的，前端會顯示更新日期。
 * 抓的是「定期時刻表」（例行班表），不含疏運或加班車。
 *
 * 部署：右上「部署 → 新增部署作業 → 網頁應用程式」
 *   執行身分：我　　誰可以存取：任何人
 * 靜態網頁只能呼叫「任何人」等級的 Web App，所以才需要 ACCESS_KEY 當閘門。
 * 部署後複製 /exec 結尾的網址，貼進前端設定。
 *
 * 試算表的分頁會自動建立，不必手動開：
 *   地點快取   地址 | 緯度 | 經度 | 更新時間
 *   餐廳快取   格號 | 名稱 | 地址 | 緯度 | 經度 | 評分 | 價位 | 營業時間JSON | 更新時間
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

function doPost(e) {
  var out;
  try {
    var req = JSON.parse(e.postData.contents || '{}');
    var need = prop_('ACCESS_KEY');
    if (need && req.key !== need) throw new Error('通行碼不正確');

    switch (req.action) {
      case 'ping':    out = { ok: true, data: status_(req) }; break;
      case 'geocode': out = { ok: true, data: geocode_(req.addresses || []) }; break;
      case 'lunch':   out = { ok: true, data: lunch_(req) }; break;
      case 'timetable': out = { ok: true, data: timetable_(req) }; break;
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
  var result = addresses.map(function (a) {
    var t = String(a || '').trim();
    if (!t) return { lat: null, lng: null };
    if (map[t]) return map[t];
    if (!key) return { lat: null, lng: null };

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
  if (hit.length) return filterOpen_(hit, req);

  var key = prop_('MAPS_KEY');
  if (!key) throw new Error('指令碼屬性裡沒有 MAPS_KEY');

  var steps = [
    { rating: req.minRating,       price: req.price, radius: req.radius },
    { rating: req.minRating - 0.5, price: req.price, radius: req.radius },
    { rating: req.minRating - 0.5, price: req.price, radius: req.radius * 1.5 },
    { rating: req.minRating - 0.5, price: 3,         radius: req.radius * 1.5 }
  ];
  var found = [], note = '';
  for (var s = 0; s < steps.length; s++) {
    found = placesSearch_(key, req.lat, req.lng, steps[s]);
    if (found.length) { if (s > 0) note = '已放寬條件'; break; }
  }
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
