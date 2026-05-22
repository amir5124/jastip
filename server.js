const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Konfigurasi dari Jagel
const STORE_COMPONENT_UID = '618e70133c5ca';
const UWARUNG_COMPONENT_UID = '618b7f0c383e4';
const CODENAME = 'iknlinku';

// Default koordinat
const defaultCoords = { lat: -0.975, lng: 116.786 };

// Hitung jarak haversine (km)
function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Ambil semua toko dari component (pagination)
async function fetchAllStoresFromComponent(componentUid) {
    let allStores = [];
    let currentPage = 1;
    let lastPage = 1;
    do {
        const url = `https://app.jagel.id/api/v2/customer/component/${componentUid}?codename=${CODENAME}&page=${currentPage}&app_mode=1&per_page=24`;
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

// Ambil detail toko (mengandung origin_address)
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

// Tentukan kategori toko berdasarkan judul
function getStoreCategory(title) {
    const t = title.toLowerCase();
    if (t.includes('indomaret')) return 'indomaret';
    if (t.includes('alfamart') && !t.includes('alfamidi')) return 'alfamart';
    if (t.includes('alfamidi')) return 'alfamidi';
    if (t.includes('maxi')) return 'maxi';
    if (t.includes('laras mitra') || t.includes('buah')) return 'fresh_shop';
    return 'toko';
}

// ─────────────────────────────────────────────────────────────
// ENDPOINT STREAMING: /api/stores-stream
// Mengirim data toko secara bertahap (3 per batch)
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
            : defaultCoords;

        console.log(`📍 Stream toko dimulai — koordinat: ${userCoords.lat}, ${userCoords.lng}`);

        // Ambil semua toko dari kedua component
        console.log('📦 Mengambil toko dari component...');
        const [backendStores, uwarungStores] = await Promise.all([
            fetchAllStoresFromComponent(STORE_COMPONENT_UID),
            fetchAllStoresFromComponent(UWARUNG_COMPONENT_UID)
        ]);

        // Gabungkan dan hindari duplikat
        const mergedMap = new Map();
        [...backendStores, ...uwarungStores].forEach(store => {
            if (!mergedMap.has(store.view_uid)) {
                mergedMap.set(store.view_uid, store);
            }
        });

        const stores = Array.from(mergedMap.values());
        console.log(`📋 Total toko unik: ${stores.length}`);

        send('meta', { total: stores.length, userCoords });

        // Proses toko satu per satu dan kirim segera
        let processed = 0;
        const BATCH_SIZE = 3;

        for (let i = 0; i < stores.length; i++) {
            const store = stores[i];

            try {
                const detail = await fetchStoreDetail(store.view_uid);
                const distance = (detail.origin_lat && detail.origin_lng)
                    ? getDistance(userCoords.lat, userCoords.lng, detail.origin_lat, detail.origin_lng)
                    : null;

                const category = getStoreCategory(store.title);

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
                    seller_rating: detail.seller_rating || 4.5,
                    category: category
                };

                send('store', storeData);
                processed++;

                console.log(`  ✅ [${processed}/${stores.length}] ${store.title} (${category}) — ${distance?.toFixed(2) || '?'} km`);

            } catch (err) {
                console.log(`  ⚠️ Gagal load ${store.title}: ${err.message}`);
                send('store_error', { view_uid: store.view_uid, title: store.title, error: err.message });
            }

            // Delay kecil agar tidak overload
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        send('done', { total: processed });
        console.log(`✅ Stream toko selesai — ${processed} toko dikirim`);
        res.end();

    } catch (error) {
        console.error('❌ Stream error:', error.message);
        send('error', { message: error.message });
        res.end();
    }
});

// ─────────────────────────────────────────────────────────────
// ENDPOINT LAMA: /api/all-stores (untuk kompatibilitas)
// ─────────────────────────────────────────────────────────────
app.get('/api/all-stores', async (req, res) => {
    try {
        let userLat = parseFloat(req.query.lat);
        let userLng = parseFloat(req.query.lng);
        const userCoords = (!isNaN(userLat) && !isNaN(userLng))
            ? { lat: userLat, lng: userLng }
            : defaultCoords;

        const [backendStores, uwarungStores] = await Promise.all([
            fetchAllStoresFromComponent(STORE_COMPONENT_UID),
            fetchAllStoresFromComponent(UWARUNG_COMPONENT_UID)
        ]);

        const mergedMap = new Map();
        [...backendStores, ...uwarungStores].forEach(store => {
            if (!mergedMap.has(store.view_uid)) {
                mergedMap.set(store.view_uid, store);
            }
        });

        const stores = Array.from(mergedMap.values());
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
                    seller_rating: detail.seller_rating,
                    category: getStoreCategory(store.title)
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
                    distance: null,
                    category: getStoreCategory(store.title)
                });
            }
        }

        storesWithDetail.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
        res.json({ success: true, stores: storesWithDetail, userCoords });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Backend berjalan di port ${PORT}`);
    console.log(`   📡 SSE Stream: GET /api/stores-stream?lat=...&lng=...`);
    console.log(`   📦 JSON:      GET /api/all-stores?lat=...&lng=...`);
});