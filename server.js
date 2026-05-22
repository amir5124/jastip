const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Konfigurasi dari Jagel
const STORE_COMPONENT_UID = '618e70133c5ca';  // untuk toko
const MENU_COMPONENT_UID = '618b7f0c383e4';   // untuk menu (BARU)
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
        const url = `https://app.jagel.id/api/v2/customer/component/${STORE_COMPONENT_UID}?codename=${CODENAME}&page=${currentPage}&app_mode=1&per_page=24`;
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

// Ambil semua menu dari component baru (pagination)
async function fetchAllMenusFromComponent() {
    let allMenus = [];
    let currentPage = 1;
    let lastPage = 1;
    do {
        const url = `https://app.jagel.id/api/v2/customer/component/${MENU_COMPONENT_UID}?codename=${CODENAME}&page=${currentPage}&app_mode=1&per_page=24`;
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0',
                'Origin': 'https://app.linku.co.id',
                'Referer': 'https://app.linku.co.id/',
                'Accept': 'application/json'
            }
        });
        if (!response.data.success) throw new Error('Menu Component API error');
        const lists = response.data.data.lists;
        allMenus.push(...(lists.data || []));
        lastPage = lists.last_page;
        currentPage++;
    } while (currentPage <= lastPage);
    return allMenus;
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

// Ambil detail menu (jika perlu)
async function fetchMenuDetail(viewUid) {
    const url = `https://app.jagel.id/api/v2/customer/list/${viewUid}?codename=${CODENAME}`;
    const response = await axios.get(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0',
            'Origin': 'https://app.linku.co.id',
            'Referer': 'https://app.linku.co.id/',
            'Accept': 'application/json'
        }
    });
    if (!response.data.success) throw new Error(`Menu Detail API error for ${viewUid}`);
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
                    origin_address: detail.origin_address || '',  // ✅ origin_address diambil
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
// ENDPOINT KHUSUS: /api/store/:viewUid (untuk mengambil detail satu toko)
// ─────────────────────────────────────────────────────────────
app.get('/api/store/:viewUid', async (req, res) => {
    try {
        const { viewUid } = req.params;
        const detail = await fetchStoreDetail(viewUid);

        // Ambil data yang diperlukan termasuk origin_address
        const storeData = {
            success: true,
            data: {
                view_uid: detail.view_uid,
                title: detail.title,
                content: detail.content,
                origin_address: detail.origin_address || '',  // ✅ origin_address diambil
                origin_lat: detail.origin_lat,
                origin_lng: detail.origin_lng,
                set_origin_flag: detail.set_origin_flag,
                is_open: detail.is_open,
                close_status: detail.close_status,
                working_hour: detail.working_hour,
                image: detail.image,
                seller_rating: detail.seller_rating,
                price: detail.price,
                weight: detail.weight,
                expedition: detail.expedition,
                max_distance: detail.max_distance
            }
        };

        res.json(storeData);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─────────────────────────────────────────────────────────────
// ENDPOINT BARU 1: /api/menus-stream → Server-Sent Events untuk MENU
// ─────────────────────────────────────────────────────────────
app.get('/api/menus-stream', async (req, res) => {
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
        console.log(`🍽️  Stream menu dimulai`);

        const menus = await fetchAllMenusFromComponent();
        console.log(`📋 Total menu: ${menus.length}`);

        send('meta', { total: menus.length, type: 'menu' });

        const BATCH_SIZE = 5;
        let index = 0;

        for (let i = 0; i < menus.length; i += BATCH_SIZE) {
            const batch = menus.slice(i, i + BATCH_SIZE);

            await Promise.all(
                batch.map(async (menu) => {
                    try {
                        const detail = await fetchMenuDetail(menu.view_uid);

                        const menuData = {
                            view_uid: menu.view_uid,
                            title: menu.title,
                            image: menu.image,
                            content: detail.content || '',
                            price: detail.price || null,
                            category: detail.category || '',
                            is_available: detail.is_available || 1,
                            seller_rating: detail.seller_rating,
                            link_view: menu.link_view
                        };

                        console.log(`  ✅ [${++index}/${menus.length}] ${menu.title}`);
                        send('menu', menuData);
                    } catch (err) {
                        send('menu', {
                            view_uid: menu.view_uid,
                            title: menu.title,
                            image: menu.image,
                            content: '',
                            price: null,
                            category: '',
                            is_available: 0,
                            link_view: menu.link_view,
                            _error: true
                        });
                        console.warn(`  ⚠️  Gagal load menu ${menu.title}: ${err.message}`);
                    }
                })
            );
        }

        send('done', { total: menus.length });
        console.log(`✅ Stream menu selesai — ${menus.length} menu dikirim`);
        res.end();

    } catch (error) {
        console.error('❌ Stream menu error:', error.message);
        send('error', { message: error.message });
        res.end();
    }
});

// ─────────────────────────────────────────────────────────────
// ENDPOINT BARU 2: /api/stores-stream  →  Server-Sent Events untuk TOKO
// (dengan origin_address)
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

        const stores = await fetchAllStoresFromComponent();
        console.log(`📋 Total toko: ${stores.length}`);

        send('meta', { total: stores.length, userCoords, type: 'store' });

        const BATCH_SIZE = 5;
        let index = 0;

        for (let i = 0; i < stores.length; i += BATCH_SIZE) {
            const batch = stores.slice(i, i + BATCH_SIZE);

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
                            origin_address: detail.origin_address || '',  // ✅ origin_address diambil
                            origin_lat: detail.origin_lat,
                            origin_lng: detail.origin_lng,
                            link_view: store.link_view,
                            distance,
                            seller_rating: detail.seller_rating
                        };

                        console.log(`  ✅ [${++index}/${stores.length}] ${store.title} — ${distance?.toFixed(2)} km`);
                        console.log(`      📍 Alamat: ${storeData.origin_address.substring(0, 50)}...`); // Log alamat
                        send('store', storeData);
                    } catch (err) {
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
        console.log(`✅ Stream toko selesai — ${stores.length} toko dikirim`);
        res.end();

    } catch (error) {
        console.error('❌ Stream toko error:', error.message);
        send('error', { message: error.message });
        res.end();
    }
});

// ─────────────────────────────────────────────────────────────
// ENDPOINT UNTUK MENDAPATKAN SEMUA MENU (JSON biasa)
// ─────────────────────────────────────────────────────────────
app.get('/api/all-menus', async (req, res) => {
    try {
        const menus = await fetchAllMenusFromComponent();
        const menusWithDetail = [];

        for (const menu of menus) {
            try {
                const detail = await fetchMenuDetail(menu.view_uid);
                menusWithDetail.push({
                    view_uid: menu.view_uid,
                    title: menu.title,
                    image: menu.image,
                    content: detail.content || '',
                    price: detail.price || null,
                    category: detail.category || '',
                    is_available: detail.is_available || 1,
                    seller_rating: detail.seller_rating,
                    link_view: menu.link_view
                });
            } catch {
                menusWithDetail.push({
                    view_uid: menu.view_uid,
                    title: menu.title,
                    image: menu.image,
                    content: '',
                    price: null,
                    category: '',
                    is_available: 0,
                    link_view: menu.link_view
                });
            }
        }

        res.json({ success: true, menus: menusWithDetail, total: menusWithDetail.length });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─────────────────────────────────────────────────────────────
// ENDPOINT UNTUK MENDAPATKAN ORIGIN_ADDRESS SAJA (lightweight)
// ─────────────────────────────────────────────────────────────
app.get('/api/store/:viewUid/address', async (req, res) => {
    try {
        const { viewUid } = req.params;
        const detail = await fetchStoreDetail(viewUid);

        res.json({
            success: true,
            data: {
                view_uid: detail.view_uid,
                title: detail.title,
                origin_address: detail.origin_address || '',
                origin_lat: detail.origin_lat,
                origin_lng: detail.origin_lng
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Backend berjalan di port ${PORT}`);
    console.log(`\n📦 ENDPOINT TERSEDIA:`);
    console.log(`   🏪 Toko (SSE)       : GET /api/stores-stream?lat=...&lng=...`);
    console.log(`   🏪 Toko (JSON)      : GET /api/all-stores?lat=...&lng=...`);
    console.log(`   🏪 Detail Toko      : GET /api/store/:viewUid`);
    console.log(`   🏪 Alamat Toko      : GET /api/store/:viewUid/address`);
    console.log(`   🍽️  Menu (SSE)      : GET /api/menus-stream`);
    console.log(`   🍽️  Menu (JSON)     : GET /api/all-menus`);
});