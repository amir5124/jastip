const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ─── KONFIGURASI ──────────────────────────────────────────────
const STORE_COMPONENT_UID = '618e70133c5ca';
const UWARUNG_COMPONENT_UID = '618b7f0c383e4';
const CODENAME = 'iknlinku';
const DEFAULT_COORDS = { lat: -0.975, lng: 116.786 };
const BATCH_SIZE = 3; // Kirim ke frontend setiap 3 toko selesai diproses

// ─── KATEGORISASI TOKO ────────────────────────────────────────
// Urutan penting: cek yang lebih spesifik dulu
function getStoreCategory(title = '') {
    const t = title.toLowerCase();
    if (t.includes('alfamidi')) return 'alfamidi';
    if (t.includes('alfamart')) return 'alfamart';
    if (t.includes('indomaret')) return 'indomaret';
    if (t.includes('laras mitra') || t.includes('buah') || t.includes('fresh')) return 'fresh_shop';
    return 'toko'; // default: toko umum
}

// ─── HAVERSINE ────────────────────────────────────────────────
function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── FETCH HELPERS ────────────────────────────────────────────
const HEADERS = {
    'User-Agent': 'Mozilla/5.0',
    'Origin': 'https://app.linku.co.id',
    'Referer': 'https://app.linku.co.id/',
    'Accept': 'application/json'
};

async function fetchAllStoresFromUWarung() {
    let all = [], page = 1, last = 1;
    do {
        const url = `https://app.jagel.id/api/v2/customer/component/${UWARUNG_COMPONENT_UID}?codename=${CODENAME}&page=${page}&app_mode=1&per_page=24`;
        const r = await axios.get(url, { headers: HEADERS });
        if (!r.data.success) throw new Error('UWarung API error');
        const lists = r.data.data.lists;
        all.push(...(lists.data || []));
        last = lists.last_page;
        page++;
    } while (page <= last);
    return all;
}

async function fetchStoreDetail(viewUid) {
    const url = `https://app.jagel.id/api/v2/customer/list/${viewUid}?codename=${CODENAME}`;
    const r = await axios.get(url, { headers: HEADERS });
    if (!r.data.success) throw new Error(`Detail error for ${viewUid}`);
    return r.data.data;
}

// ─── ENDPOINT: /api/stores-stream ─────────────────────────────
// Streaming 3 toko per batch via Server-Sent Events
// ─────────────────────────────────────────────────────────────
app.get('/api/stores-stream', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const send = (event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        if (typeof res.flush === 'function') res.flush();
    };

    req.on('close', () => res.end());

    try {
        const userLat = parseFloat(req.query.lat);
        const userLng = parseFloat(req.query.lng);
        const userCoords = (!isNaN(userLat) && !isNaN(userLng))
            ? { lat: userLat, lng: userLng }
            : DEFAULT_COORDS;

        console.log(`🚀 Stream dimulai — lat:${userCoords.lat} lng:${userCoords.lng}`);

        // Ambil daftar toko
        const stores = await fetchAllStoresFromUWarung();
        console.log(`📋 Total toko: ${stores.length}`);

        send('meta', { total_stores: stores.length, userCoords });

        let batch = [];
        let totalDone = 0;

        for (let i = 0; i < stores.length; i++) {
            const store = stores[i];

            try {
                const detail = await fetchStoreDetail(store.view_uid);

                const lat = detail.origin_lat ? parseFloat(detail.origin_lat) : null;
                const lng = detail.origin_lng ? parseFloat(detail.origin_lng) : null;
                const distance = (lat && lng)
                    ? getDistance(userCoords.lat, userCoords.lng, lat, lng)
                    : null;

                const category = getStoreCategory(store.title);

                batch.push({
                    view_uid: store.view_uid,
                    title: store.title || '',
                    image: store.image || '',
                    content: detail.content || '',
                    origin_address: detail.origin_address || '',
                    origin_lat: lat,
                    origin_lng: lng,
                    distance,
                    is_open: detail.is_open ?? 1,
                    close_status: detail.close_status || '',
                    close_time: detail.close_time || '',
                    seller_rating: parseFloat(detail.seller_rating) || 4.8,
                    link_view: store.link_view || '',
                    category // ← kategori sudah benar di sini
                });

                totalDone++;
                console.log(`[${totalDone}/${stores.length}] ${store.title} → ${category}`);

                // Kirim batch setiap 3 toko (atau toko terakhir)
                if (batch.length >= BATCH_SIZE || i === stores.length - 1) {
                    send('batch', {
                        stores: batch,
                        progress: { done: totalDone, total: stores.length }
                    });
                    batch = [];
                }

            } catch (err) {
                console.warn(`⚠️ Skip ${store.title}: ${err.message}`);
                totalDone++;

                // Tetap kirim store dengan data minimal agar tidak hilang
                batch.push({
                    view_uid: store.view_uid,
                    title: store.title || '',
                    image: store.image || '',
                    content: '',
                    origin_address: '',
                    origin_lat: null,
                    origin_lng: null,
                    distance: null,
                    is_open: 1,
                    close_status: '',
                    close_time: '',
                    seller_rating: 4.8,
                    link_view: store.link_view || '',
                    category: getStoreCategory(store.title),
                    _error: true
                });

                if (batch.length >= BATCH_SIZE || i === stores.length - 1) {
                    send('batch', {
                        stores: batch,
                        progress: { done: totalDone, total: stores.length }
                    });
                    batch = [];
                }
            }
        }

        send('done', { total: totalDone });
        console.log(`✅ Stream selesai — ${totalDone} toko`);
        res.end();

    } catch (err) {
        console.error('❌ Stream error:', err.message);
        send('error', { message: err.message });
        res.end();
    }
});

// ─── ENDPOINT LAMA (kompatibilitas) ───────────────────────────
app.get('/api/all-stores', async (req, res) => {
    try {
        const userLat = parseFloat(req.query.lat);
        const userLng = parseFloat(req.query.lng);
        const userCoords = (!isNaN(userLat) && !isNaN(userLng))
            ? { lat: userLat, lng: userLng }
            : DEFAULT_COORDS;

        const stores = await fetchAllStoresFromUWarung();
        const result = [];

        for (const store of stores) {
            try {
                const detail = await fetchStoreDetail(store.view_uid);
                const lat = detail.origin_lat ? parseFloat(detail.origin_lat) : null;
                const lng = detail.origin_lng ? parseFloat(detail.origin_lng) : null;
                result.push({
                    view_uid: store.view_uid,
                    title: store.title || '',
                    image: store.image || '',
                    content: detail.content || '',
                    origin_address: detail.origin_address || '',
                    origin_lat: lat,
                    origin_lng: lng,
                    distance: (lat && lng) ? getDistance(userCoords.lat, userCoords.lng, lat, lng) : null,
                    is_open: detail.is_open ?? 1,
                    close_status: detail.close_status || '',
                    close_time: detail.close_time || '',
                    seller_rating: parseFloat(detail.seller_rating) || 4.8,
                    link_view: store.link_view || '',
                    category: getStoreCategory(store.title)
                });
            } catch {
                result.push({
                    view_uid: store.view_uid,
                    title: store.title || '',
                    image: store.image || '',
                    content: '', origin_address: '', origin_lat: null, origin_lng: null,
                    distance: null, is_open: 1, close_status: '', close_time: '',
                    seller_rating: 4.8, link_view: store.link_view || '',
                    category: getStoreCategory(store.title)
                });
            }
        }

        result.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
        res.json({ success: true, stores: result, userCoords });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/store/:viewUid', async (req, res) => {
    try {
        const detail = await fetchStoreDetail(req.params.viewUid);
        res.json({ success: true, data: detail });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`\n🚀 Server berjalan di port ${PORT}`);
    console.log(`\n📡 ENDPOINTS:`);
    console.log(`   GET /api/stores-stream?lat=...&lng=...  ← SSE, 3 toko per batch`);
    console.log(`   GET /api/all-stores?lat=...&lng=...     ← JSON biasa`);
    console.log(`   GET /api/store/:viewUid                 ← detail 1 toko\n`);
});