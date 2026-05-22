const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Konfigurasi dari Jagel
const STORE_COMPONENT_UID = '618e70133c5ca';  // untuk toko (all-stores)
const UWARUNG_COMPONENT_UID = '618b7f0c383e4'; // UWarung - daftar toko
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

// Ambil semua toko dari component UWarung (pagination)
async function fetchAllStoresFromUWarung() {
    let allStores = [];
    let currentPage = 1;
    let lastPage = 1;
    do {
        const url = `https://app.jagel.id/api/v2/customer/component/${UWARUNG_COMPONENT_UID}?codename=${CODENAME}&page=${currentPage}&app_mode=1&per_page=24`;
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0',
                'Origin': 'https://app.linku.co.id',
                'Referer': 'https://app.linku.co.id/',
                'Accept': 'application/json'
            }
        });
        if (!response.data.success) throw new Error('UWarung Component API error');
        const lists = response.data.data.lists;
        allStores.push(...(lists.data || []));
        lastPage = lists.last_page;
        currentPage++;
    } while (currentPage <= lastPage);
    return allStores;
}

// Ambil semua toko dari component store (pagination)
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

// Ambil semua produk dari sebuah toko
async function fetchStoreProducts(viewUid) {
    try {
        // Endpoint untuk mengambil produk dalam toko
        const url = `https://app.jagel.id/api/v2/customer/list/${viewUid}/product?codename=${CODENAME}&page=1&per_page=100`;
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0',
                'Origin': 'https://app.linku.co.id',
                'Referer': 'https://app.linku.co.id/',
                'Accept': 'application/json'
            }
        });
        if (response.data.success && response.data.data && response.data.data.products) {
            return response.data.data.products.data || [];
        }
        return [];
    } catch (error) {
        console.log(`Tidak bisa ambil produk untuk toko ${viewUid}: ${error.message}`);
        return [];
    }
}

// ─────────────────────────────────────────────────────────────
// ENDPOINT BARU: /api/all-products - Mengambil semua produk dari semua toko
// Setiap produk memiliki origin_address dari tokonya
// ─────────────────────────────────────────────────────────────
app.get('/api/all-products', async (req, res) => {
    try {
        let userLat = parseFloat(req.query.lat);
        let userLng = parseFloat(req.query.lng);
        const userCoords = (!isNaN(userLat) && !isNaN(userLng))
            ? { lat: userLat, lng: userLng }
            : defaultCoords;

        console.log('📍 Mengambil semua toko dari UWarung...');

        // 1. Ambil semua toko dari UWarung
        const stores = await fetchAllStoresFromUWarung();
        console.log(`📋 Ditemukan ${stores.length} toko`);

        const allProducts = [];

        // 2. Untuk setiap toko, ambil detail (termasuk origin_address) dan produknya
        for (let i = 0; i < stores.length; i++) {
            const store = stores[i];
            console.log(`🔄 Memproses toko ${i + 1}/${stores.length}: ${store.title}`);

            try {
                // Ambil detail toko (termasuk origin_address)
                const storeDetail = await fetchStoreDetail(store.view_uid);

                // Ambil produk dari toko ini
                const products = await fetchStoreProducts(store.view_uid);

                // Hitung jarak toko dari user
                const storeDistance = (storeDetail.origin_lat && storeDetail.origin_lng)
                    ? getDistance(userCoords.lat, userCoords.lng, storeDetail.origin_lat, storeDetail.origin_lng)
                    : null;

                // Untuk setiap produk, tambahkan informasi toko (termasuk origin_address)
                for (const product of products) {
                    allProducts.push({
                        // Informasi produk
                        product_view_uid: product.view_uid,
                        product_title: product.title,
                        product_image: product.image,
                        product_price: product.price,
                        product_content: product.content || '',
                        product_category: product.category_name || '',

                        // Informasi toko (dengan origin_address)
                        store_view_uid: store.view_uid,
                        store_title: store.title,
                        store_image: store.image,
                        store_origin_address: storeDetail.origin_address || '',
                        store_origin_lat: storeDetail.origin_lat,
                        store_origin_lng: storeDetail.origin_lng,
                        store_distance: storeDistance,
                        store_rating: storeDetail.seller_rating,
                        store_is_open: storeDetail.is_open,

                        // Link
                        link_view: store.link_view
                    });
                }

                console.log(`   ✅ Mendapatkan ${products.length} produk dari ${store.title}`);

            } catch (error) {
                console.log(`   ⚠️ Gagal memproses ${store.title}: ${error.message}`);
            }
        }

        // Urutkan berdasarkan jarak terdekat
        allProducts.sort((a, b) => (a.store_distance ?? Infinity) - (b.store_distance ?? Infinity));

        console.log(`✅ Selesai! Total ${allProducts.length} produk ditemukan`);

        res.json({
            success: true,
            total_products: allProducts.length,
            total_stores: stores.length,
            products: allProducts,
            userCoords
        });

    } catch (error) {
        console.error('❌ Error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─────────────────────────────────────────────────────────────
// ENDPOINT: /api/all-products-stream - Server-Sent Events untuk produk
// ─────────────────────────────────────────────────────────────
app.get('/api/all-products-stream', async (req, res) => {
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

        console.log(`📍 Stream produk dimulai — koordinat: ${userCoords.lat}, ${userCoords.lng}`);

        // Ambil semua toko dari UWarung
        const stores = await fetchAllStoresFromUWarung();
        console.log(`📋 Total toko: ${stores.length}`);

        send('meta', { total_stores: stores.length, userCoords, type: 'products' });

        let totalProducts = 0;

        // Proses setiap toko satu per satu
        for (let i = 0; i < stores.length; i++) {
            const store = stores[i];

            try {
                const storeDetail = await fetchStoreDetail(store.view_uid);
                const products = await fetchStoreProducts(store.view_uid);

                const storeDistance = (storeDetail.origin_lat && storeDetail.origin_lng)
                    ? getDistance(userCoords.lat, userCoords.lng, storeDetail.origin_lat, storeDetail.origin_lng)
                    : null;

                // Kirim event untuk setiap produk
                for (const product of products) {
                    const productData = {
                        product_view_uid: product.view_uid,
                        product_title: product.title,
                        product_image: product.image,
                        product_price: product.price,
                        product_content: product.content || '',
                        product_category: product.category_name || '',
                        store_view_uid: store.view_uid,
                        store_title: store.title,
                        store_image: store.image,
                        store_origin_address: storeDetail.origin_address || '',
                        store_origin_lat: storeDetail.origin_lat,
                        store_origin_lng: storeDetail.origin_lng,
                        store_distance: storeDistance,
                        store_rating: storeDetail.seller_rating,
                        store_is_open: storeDetail.is_open,
                        link_view: store.link_view
                    };

                    send('product', productData);
                    totalProducts++;
                }

                console.log(`✅ [${i + 1}/${stores.length}] ${store.title} → ${products.length} produk dikirim`);

                // Kirim progress
                send('progress', {
                    store_index: i + 1,
                    total_stores: stores.length,
                    store_name: store.title,
                    products_from_store: products.length,
                    total_products_so_far: totalProducts
                });

            } catch (error) {
                console.log(`⚠️ Gagal memproses ${store.title}: ${error.message}`);
                send('error_store', {
                    store_name: store.title,
                    error: error.message
                });
            }
        }

        send('done', { total_products: totalProducts, total_stores: stores.length });
        console.log(`✅ Stream produk selesai — ${totalProducts} produk dikirim dari ${stores.length} toko`);
        res.end();

    } catch (error) {
        console.error('❌ Stream produk error:', error.message);
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
// ENDPOINT: /api/store/:viewUid (detail toko)
// ─────────────────────────────────────────────────────────────
app.get('/api/store/:viewUid', async (req, res) => {
    try {
        const { viewUid } = req.params;
        const detail = await fetchStoreDetail(viewUid);

        res.json({
            success: true,
            data: {
                view_uid: detail.view_uid,
                title: detail.title,
                content: detail.content,
                origin_address: detail.origin_address || '',
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
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─────────────────────────────────────────────────────────────
// ENDPOINT: /api/store/:viewUid/products (produk dari toko tertentu)
// ─────────────────────────────────────────────────────────────
app.get('/api/store/:viewUid/products', async (req, res) => {
    try {
        const { viewUid } = req.params;
        const storeDetail = await fetchStoreDetail(viewUid);
        const products = await fetchStoreProducts(viewUid);

        res.json({
            success: true,
            store: {
                view_uid: storeDetail.view_uid,
                title: storeDetail.title,
                origin_address: storeDetail.origin_address || '',
                origin_lat: storeDetail.origin_lat,
                origin_lng: storeDetail.origin_lng
            },
            products: products,
            total_products: products.length
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─────────────────────────────────────────────────────────────
// ENDPOINT: /api/stores-from-uwarung (daftar toko dari UWarung)
// ─────────────────────────────────────────────────────────────
app.get('/api/stores-from-uwarung', async (req, res) => {
    try {
        const stores = await fetchAllStoresFromUWarung();

        // Ambil detail untuk setiap toko (termasuk origin_address)
        const storesWithDetail = [];
        for (const store of stores) {
            try {
                const detail = await fetchStoreDetail(store.view_uid);
                storesWithDetail.push({
                    view_uid: store.view_uid,
                    title: store.title,
                    image: store.image,
                    origin_address: detail.origin_address || '',
                    origin_lat: detail.origin_lat,
                    origin_lng: detail.origin_lng,
                    is_open: detail.is_open,
                    seller_rating: detail.seller_rating,
                    link_view: store.link_view
                });
            } catch (error) {
                storesWithDetail.push({
                    view_uid: store.view_uid,
                    title: store.title,
                    image: store.image,
                    origin_address: '',
                    origin_lat: null,
                    origin_lng: null,
                    is_open: 0,
                    link_view: store.link_view
                });
            }
        }

        res.json({
            success: true,
            total_stores: storesWithDetail.length,
            stores: storesWithDetail
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Backend berjalan di port ${PORT}`);
    console.log(`\n📦 ENDPOINT TERSEDIA:`);
    console.log(`   🛍️  Semua Produk (JSON) : GET /api/all-products?lat=...&lng=...`);
    console.log(`   🛍️  Semua Produk (SSE)  : GET /api/all-products-stream?lat=...&lng=...`);
    console.log(`   🏪  Semua Toko (JSON)   : GET /api/all-stores?lat=...&lng=...`);
    console.log(`   🏪  Toko dari UWarung   : GET /api/stores-from-uwarung`);
    console.log(`   🏪  Detail Toko         : GET /api/store/:viewUid`);
    console.log(`   🍽️  Produk Toko        : GET /api/store/:viewUid/products`);
});