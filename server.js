const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Konfigurasi dari Jagel
const COMPONENT_VIEW_UID = '618e70133c5ca';
const CODENAME = 'iknlinku';

// Default koordinat (Sepaku, Kalimantan Timur)
const defaultCoords = { lat: -0.975, lng: 116.786 };

// Hitung jarak haversine (km)
function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Ambil semua toko dari component (pagination)
async function fetchAllStoresFromComponent() {
    let allStores = [];
    let currentPage = 1;
    let lastPage = 1;
    do {
        const url = `https://app.jagel.id/api/v2/customer/component/${COMPONENT_VIEW_UID}?codename=${CODENAME}&page=${currentPage}&app_mode=1&per_page=24`;
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0',
                'Origin': 'https://app.linku.co.id',
                'Referer': 'https://app.linku.co.id/',
                'Accept': 'application/json'
            }
        });
        if (!response.data.success) throw new Error('Component API error');
        const lists = response.data.data.lists;
        allStores.push(...(lists.data || []));
        lastPage = lists.last_page;
        currentPage++;
    } while (currentPage <= lastPage);
    return allStores;
}

// Ambil detail toko
async function fetchStoreDetail(viewUid) {
    const url = `https://app.jagel.id/api/v2/customer/list/${viewUid}?codename=${CODENAME}`;
    const response = await axios.get(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0',
            'Origin': 'https://app.linku.co.id',
            'Referer': 'https://app.linku.co.id/',
            'Accept': 'application/json'
        }
    });
    if (!response.data.success) throw new Error(`Detail API error for ${viewUid}`);
    return response.data.data;
}

// ─────────────────────────────────────────────────────────────
// ENDPOINT LAMA: /api/all-stores (tetap ada, untuk kompatibilitas)
// ─────────────────────────────────────────────────────────────
app.get('/api/all-stores', async (req, res) => {
    try {
        let userLat = parseFloat(req.query.lat);
        let userLng = parseFloat(req.query.lng);
        const userCoords = (!isNaN(userLat) && !isNaN(userLng))
            ? { lat: userLat, lng: userLng }
            : defaultCoords;

        const stores = await fetchAllStoresFromComponent();
        const storesWithDetail = [];

        for (const store of stores) {
            try {
                const detail = await fetchStoreDetail(store.view_uid);
                const distance = (detail.origin_lat && detail.origin_lng)
                    ? getDistance(userCoords.lat, userCoords.lng, detail.origin_lat, detail.origin_lng)
                    : null;
                storesWithDetail.push({
                    view_uid: store.view_uid,
                    title: store.title,
                    image: store.image,
                    content: detail.content || '',
                    is_open: detail.is_open,
                    close_status: detail.close_status || '',
                    close_time: detail.close_time || '',
                    origin_address: detail.origin_address || '',
                    origin_lat: detail.origin_lat,
                    origin_lng: detail.origin_lng,
                    link_view: store.link_view,
                    distance,
                    seller_rating: detail.seller_rating
                });
            } catch {
                storesWithDetail.push({
                    view_uid: store.view_uid,
                    title: store.title,
                    image: store.image,
                    content: '',
                    is_open: 0,
                    close_status: 'Gagal load',
                    origin_address: '',
                    origin_lat: null,
                    origin_lng: null,
                    link_view: store.link_view,
                    distance: null
                });
            }
        }

        storesWithDetail.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
        res.json({ success: true, stores: storesWithDetail, userCoords });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─────────────────────────────────────────────────────────────
// ENDPOINT BARU: /api/stores-stream  →  Server-Sent Events
//
// Alur:
//   1. Kirim event "meta"  → info koordinat user & total toko
//   2. Ambil detail tiap toko secara PARALEL (batch 5)
//   3. Setiap toko selesai → langsung kirim event "store"
//   4. Kirim event "done"  → selesai
// ─────────────────────────────────────────────────────────────
app.get('/api/stores-stream', async (req, res) => {
    // Header SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
    res.flushHeaders();

    // Helper kirim event SSE
    const send = (event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        // Flush jika tersedia (beberapa server butuh ini)
        if (typeof res.flush === 'function') res.flush();
    };

    // Tutup koneksi jika client disconnect
    req.on('close', () => res.end());

    try {
        // Koordinat user
        const userLat = parseFloat(req.query.lat);
        const userLng = parseFloat(req.query.lng);
        const userCoords = (!isNaN(userLat) && !isNaN(userLng))
            ? { lat: userLat, lng: userLng }
            : defaultCoords;

        console.log(`📍 Stream dimulai — koordinat: ${userCoords.lat}, ${userCoords.lng}`);

        // Ambil daftar toko dari component (pagination)
        const stores = await fetchAllStoresFromComponent();
        console.log(`📋 Total toko: ${stores.length}`);

        // Kirim meta dulu supaya frontend tahu total
        send('meta', { total: stores.length, userCoords });

        // Proses detail toko secara paralel per BATCH
        const BATCH_SIZE = 5; // ambil 5 toko sekaligus
        let index = 0;

        for (let i = 0; i < stores.length; i += BATCH_SIZE) {
            const batch = stores.slice(i, i + BATCH_SIZE);

            // Jalankan batch secara paralel, tiap yang selesai langsung kirim
            await Promise.all(
                batch.map(async (store) => {
                    try {
                        const detail = await fetchStoreDetail(store.view_uid);
                        const distance = (detail.origin_lat && detail.origin_lng)
                            ? getDistance(userCoords.lat, userCoords.lng, detail.origin_lat, detail.origin_lng)
                            : null;

                        const storeData = {
                            view_uid: store.view_uid,
                            title: store.title,
                            image: store.image,
                            content: detail.content || '',
                            is_open: detail.is_open,
                            close_status: detail.close_status || '',
                            close_time: detail.close_time || '',
                            origin_address: detail.origin_address || '',
                            origin_lat: detail.origin_lat,
                            origin_lng: detail.origin_lng,
                            link_view: store.link_view,
                            distance,
                            seller_rating: detail.seller_rating
                        };

                        console.log(`  ✅ [${++index}/${stores.length}] ${store.title} — ${distance?.toFixed(2)} km`);
                        send('store', storeData); // langsung kirim ke frontend!
                    } catch (err) {
                        // Tetap kirim walau gagal, supaya counter frontend sinkron
                        send('store', {
                            view_uid: store.view_uid,
                            title: store.title,
                            image: store.image,
                            content: '',
                            is_open: 0,
                            close_status: 'Gagal load',
                            close_time: '',
                            origin_address: '',
                            origin_lat: null,
                            origin_lng: null,
                            link_view: store.link_view,
                            distance: null,
                            seller_rating: null,
                            _error: true
                        });
                        console.warn(`  ⚠️  Gagal load ${store.title}: ${err.message}`);
                    }
                })
            );
        }

        send('done', { total: stores.length });
        console.log(`✅ Stream selesai — ${stores.length} toko dikirim`);
        res.end();

    } catch (error) {
        console.error('❌ Stream error:', error.message);
        send('error', { message: error.message });
        res.end();
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Backend berjalan di port ${PORT}`);
    console.log(`   → SSE stream: GET /api/stores-stream?lat=...&lng=...`);
    console.log(`   → JSON lama : GET /api/all-stores?lat=...&lng=...`);
});