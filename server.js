const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ─────────────────────────────────────────────────────────────
// KONFIGURASI
// ─────────────────────────────────────────────────────────────
const STORE_COMPONENT_UID = '618e70133c5ca';   // all-stores (Jastip)
const UWARUNG_COMPONENT_UID = '618b7f0c383e4';   // UWarung - daftar toko
const APOTEK_COMPONENT_UID = '61888b919f524';   // Jastip Apotek - daftar toko
const MAKANAN_COMPONENT_UID = '618637dbc8415';   // Jastip Makanan - daftar toko
const CODENAME = 'iknlinku';
const BATCH_SIZE = 3; // Jumlah toko per batch SSE

// Default koordinat (Sepaku, Kalimantan Timur)
const defaultCoords = { lat: -0.975, lng: 116.786 };

// ─────────────────────────────────────────────────────────────
// UTILITAS
// ─────────────────────────────────────────────────────────────

/** Hitung jarak haversine (km) */
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

/** Parse koordinat dari query string */
function parseUserCoords(query) {
    const lat = parseFloat(query.lat);
    const lng = parseFloat(query.lng);
    return (!isNaN(lat) && !isNaN(lng)) ? { lat, lng } : defaultCoords;
}

/** Helper header default untuk request ke Jagel */
const jagelHeaders = {
    'User-Agent': 'Mozilla/5.0',
    'Origin': 'https://app.linku.co.id',
    'Referer': 'https://app.linku.co.id/',
    'Accept': 'application/json'
};

/** Bagi array menjadi chunk ukuran n */
function chunk(arr, n) {
    const result = [];
    for (let i = 0; i < arr.length; i += n) result.push(arr.slice(i, i + n));
    return result;
}

// ─────────────────────────────────────────────────────────────
// FUNGSI FETCH DATA DARI JAGEL (ORIGINAL - TIDAK DIUBAH)
// ─────────────────────────────────────────────────────────────

/** Ambil semua toko dari component (pagination otomatis) */
async function fetchAllStoresFromComponent(componentUid) {
    let all = [], page = 1, lastPage = 1;
    do {
        const url = `https://app.jagel.id/api/v2/customer/component/${componentUid}`
            + `?codename=${CODENAME}&page=${page}&app_mode=1&per_page=24`;
        const { data } = await axios.get(url, { headers: jagelHeaders });
        if (!data.success) throw new Error(`Component API error (uid=${componentUid})`);
        const lists = data.data.lists;
        all.push(...(lists.data || []));
        lastPage = lists.last_page;
        page++;
    } while (page <= lastPage);
    return all;
}

/** Ambil detail satu toko (berisi origin_address, rating, dll.) */
async function fetchStoreDetail(viewUid) {
    const url = `https://app.jagel.id/api/v2/customer/list/${viewUid}?codename=${CODENAME}`;
    const { data } = await axios.get(url, { headers: jagelHeaders });
    if (!data.success) throw new Error(`Detail API error for ${viewUid}`);
    return data.data;
}

/** Ambil semua children dari suatu component (fungsi baru untuk kategori & produk) */
async function fetchChildren(parentUid, page = 1, perPage = 100) {
    try {
        const url = `https://app.jagel.id/api/v2/customer/list/${parentUid}/children`
            + `?codename=${CODENAME}&page=${page}&per_page=${perPage}`;
        const { data } = await axios.get(url, { headers: jagelHeaders });
        if (!data.success) return { items: [], lastPage: 1 };
        return {
            items: data.data.data || [],
            lastPage: data.data.last_page || 1
        };
    } catch (err) {
        console.log(`⚠️  Fetch children ${parentUid}: ${err.message}`);
        return { items: [], lastPage: 1 };
    }
}

/** Ambil semua kategori dari toko (children dengan type=4) */
async function fetchStoreCategories(viewUid) {
    let allCategories = [];
    let page = 1;
    let lastPage = 1;

    do {
        const { items, lastPage: lp } = await fetchChildren(viewUid, page, 100);
        // Filter hanya type = 4 (kategori menu)
        const categories = items.filter(item => item.type === 4);
        allCategories.push(...categories);
        lastPage = lp;
        page++;
    } while (page <= lastPage);

    if (allCategories.length > 0) {
        console.log(`📦 Store ${viewUid}: ${allCategories.length} kategori ditemukan`);
    }
    return allCategories;
}

/** Ambil semua produk dari suatu kategori (children dengan type=0 atau purchasable=1) */
async function fetchCategoryProducts(categoryUid) {
    let allProducts = [];
    let page = 1;
    let lastPage = 1;

    do {
        const { items, lastPage: lp } = await fetchChildren(categoryUid, page, 100);
        // Filter type = 0 (produk) atau yang memiliki purchasable = 1
        const products = items.filter(item => item.type === 0 || item.purchasable === 1);
        allProducts.push(...products);
        lastPage = lp;
        page++;
    } while (page <= lastPage);

    return allProducts;
}

/** Format produk dengan informasi lengkap (termasuk varian) */
function formatProduct(product, storeDetail, userCoords, categoryName = null) {
    const distance = (storeDetail.origin_lat && storeDetail.origin_lng)
        ? getDistance(userCoords.lat, userCoords.lng,
            parseFloat(storeDetail.origin_lat), parseFloat(storeDetail.origin_lng))
        : null;

    // Jika produk memiliki varian, proses varian
    let displayPrice = product.price || 0;
    let variants = [];

    if (product.list_product_variant && product.list_product_variant.length > 0) {
        variants = product.list_product_variant.map(v => ({
            view_uid: v.view_uid,
            name: v.name,
            price: v.price || v.new_price || 0
        }));
        // Gunakan harga termurah dari varian
        displayPrice = Math.min(...variants.map(v => v.price), displayPrice);
    }

    return {
        view_uid: product.view_uid,
        title: product.title,
        image: product.image,
        price: displayPrice,
        original_price: product.price_before_discount || product.price,
        content: product.content || '',
        product_category: categoryName || product.category_name || 'Menu Utama',
        has_variants: variants.length > 0,
        variants: variants,
        store_view_uid: storeDetail.view_uid,
        store_title: storeDetail.title,
        store_distance: distance,
        store_is_open: storeDetail.is_open === 1,
        is_open: product.is_open === 1,
        max_qty: product.max_qty
    };
}

/** Ambil semua produk dari satu toko (VERSI BARU - melalui kategori) */
async function fetchStoreProductsWithCategories(viewUid) {
    try {
        // 1. Ambil semua kategori dari toko
        const categories = await fetchStoreCategories(viewUid);

        // 2. Untuk setiap kategori, ambil produknya
        const allProducts = [];
        for (const category of categories) {
            const products = await fetchCategoryProducts(category.view_uid);

            // Tambahkan info kategori ke setiap produk
            products.forEach(product => {
                product.category_name = category.title;
                product.category_uid = category.view_uid;
            });

            allProducts.push(...products);
            if (products.length > 0) {
                console.log(`   - ${category.title}: ${products.length} produk`);
            }
        }

        // 3. Jika tidak ada kategori, coba ambil produk langsung dari toko
        if (categories.length === 0) {
            console.log(`   ⚠️ Tidak ada kategori, coba ambil produk langsung dari toko...`);
            const directProducts = await fetchCategoryProducts(viewUid);
            const produkLangusng = directProducts.filter(p => p.type === 0 || p.purchasable === 1);
            produkLangusng.forEach(product => {
                product.category_name = 'Menu Utama';
                product.category_uid = 'main';
            });
            allProducts.push(...produkLangusng);
            if (produkLangusng.length > 0) {
                console.log(`   - Langsung: ${produkLangusng.length} produk`);
            }
        }

        return allProducts;
    } catch (err) {
        console.log(`⚠️  Produk ${viewUid}: ${err.message}`);
        return [];
    }
}

/** 
 * PROSES BATCH UNTUK PRODUK (untuk SSE) - menggunakan fungsi baru
 * @param {Array}   storeList   - Array toko mentah dari component API
 * @param {Object}  userCoords  - { lat, lng }
 */
async function processBatchProducts(storeList, userCoords) {
    return Promise.all(storeList.map(async (store) => {
        try {
            const detail = await fetchStoreDetail(store.view_uid);
            const distance = (detail.origin_lat && detail.origin_lng)
                ? getDistance(userCoords.lat, userCoords.lng, parseFloat(detail.origin_lat), parseFloat(detail.origin_lng))
                : null;

            // Gunakan fungsi baru untuk ambil produk via kategori
            const products = await fetchStoreProductsWithCategories(store.view_uid);

            const productList = products.map(p => ({
                product_view_uid: p.view_uid,
                product_title: p.title,
                product_image: p.image,
                product_price: p.price || 0,
                product_content: p.content || '',
                product_category: p.category_name || '',
                product_has_variants: !!(p.list_product_variant && p.list_product_variant.length > 0),
                store_view_uid: store.view_uid,
                store_title: store.title,
                store_image: store.image,
                store_origin_address: detail.origin_address || '',
                store_origin_lat: detail.origin_lat,
                store_origin_lng: detail.origin_lng,
                store_distance: distance,
                store_rating: detail.seller_rating,
                store_is_open: detail.is_open,
                link_view: store.link_view
            }));

            return { ok: true, store_title: store.title, data: productList, count: productList.length };
        } catch (err) {
            return { ok: false, store_title: store.title, error: err.message };
        }
    }));
}

/**
 * Proses satu batch toko (paralel) → kembalikan array hasil.
 * @param {Array}   storeList   - Array toko mentah dari component API
 * @param {Object}  userCoords  - { lat, lng }
 * @param {string}  mode        - 'stores' | 'products'
 */
async function processBatch(storeList, userCoords, mode) {
    if (mode === 'products') {
        return processBatchProducts(storeList, userCoords);
    }

    return Promise.all(storeList.map(async (store) => {
        try {
            const detail = await fetchStoreDetail(store.view_uid);
            const distance = (detail.origin_lat && detail.origin_lng)
                ? getDistance(userCoords.lat, userCoords.lng, parseFloat(detail.origin_lat), parseFloat(detail.origin_lng))
                : null;

            return {
                ok: true,
                data: {
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
                }
            };
        } catch (err) {
            return { ok: false, store_title: store.title, error: err.message };
        }
    }));
}

// ─────────────────────────────────────────────────────────────
// HELPER SSE
// ─────────────────────────────────────────────────────────────

/** Setup header SSE & kembalikan fungsi send() */
function setupSSE(res) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    return (event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        if (typeof res.flush === 'function') res.flush();
    };
}

// ─────────────────────────────────────────────────────────────
// SSE: /api/stores-stream?source=jastip|uwarung|apotek&lat=&lng=
// ─────────────────────────────────────────────────────────────
app.get('/api/stores-stream', async (req, res) => {
    const send = setupSSE(res);
    req.on('close', () => res.end());

    try {
        const userCoords = parseUserCoords(req.query);
        const source = req.query.source === 'jastip'
            ? 'jastip'
            : req.query.source === 'apotek'
                ? 'apotek'
                : req.query.source === 'makanan'
                    ? 'makanan'
                    : 'uwarung';

        const uid = source === 'jastip'
            ? STORE_COMPONENT_UID
            : source === 'apotek'
                ? APOTEK_COMPONENT_UID
                : source === 'makanan'
                    ? MAKANAN_COMPONENT_UID
                    : UWARUNG_COMPONENT_UID;

        console.log(`📡 [stores-stream] source=${source}`);

        const stores = await fetchAllStoresFromComponent(uid);
        const batches = chunk(stores, BATCH_SIZE);

        send('meta', {
            total_stores: stores.length,
            total_batches: batches.length,
            batch_size: BATCH_SIZE,
            source,
            userCoords
        });

        let processedCount = 0;

        for (let bi = 0; bi < batches.length; bi++) {
            const batch = batches[bi];
            const results = await processBatch(batch, userCoords, 'stores');

            const successItems = results.filter(r => r.ok).map(r => r.data);
            const failedItems = results.filter(r => !r.ok);

            if (successItems.length > 0) {
                send('batch_stores', {
                    batch_index: bi + 1,
                    total_batches: batches.length,
                    stores: successItems
                });
            }

            failedItems.forEach(f => {
                send('error_store', { store_name: f.store_title, error: f.error });
            });

            processedCount += batch.length;

            send('progress', {
                batch_index: bi + 1,
                total_batches: batches.length,
                processed_stores: processedCount,
                total_stores: stores.length,
                percent: Math.round((processedCount / stores.length) * 100)
            });

            console.log(`✅ [stores-stream] batch ${bi + 1}/${batches.length} — ${successItems.length} toko dikirim`);
        }

        send('done', {
            total_stores: stores.length,
            total_batches: batches.length,
            source
        });
        res.end();

    } catch (err) {
        console.error('❌ [stores-stream]', err.message);
        send('error', { message: err.message });
        res.end();
    }
});

// ─────────────────────────────────────────────────────────────
// SSE: /api/all-products-stream?lat=&lng=
// ─────────────────────────────────────────────────────────────
app.get('/api/all-products-stream', async (req, res) => {
    const send = setupSSE(res);
    req.on('close', () => res.end());

    try {
        const userCoords = parseUserCoords(req.query);

        console.log(`📡 [all-products-stream] koordinat: ${userCoords.lat}, ${userCoords.lng}`);

        const stores = await fetchAllStoresFromComponent(UWARUNG_COMPONENT_UID);
        const batches = chunk(stores, BATCH_SIZE);

        send('meta', {
            total_stores: stores.length,
            total_batches: batches.length,
            batch_size: BATCH_SIZE,
            userCoords
        });

        let totalProducts = 0;
        let processedStores = 0;

        for (let bi = 0; bi < batches.length; bi++) {
            const batch = batches[bi];
            const results = await processBatch(batch, userCoords, 'products');

            const batchProducts = [];

            results.forEach(r => {
                if (r.ok) {
                    batchProducts.push(...r.data);
                    console.log(`  ✅ ${r.store_title} → ${r.count || r.data.length} produk`);
                } else {
                    send('error_store', { store_name: r.store_title, error: r.error });
                    console.log(`  ⚠️  ${r.store_title}: ${r.error}`);
                }
            });

            if (batchProducts.length > 0) {
                batchProducts.sort((a, b) => (a.store_distance ?? Infinity) - (b.store_distance ?? Infinity));

                send('batch_products', {
                    batch_index: bi + 1,
                    total_batches: batches.length,
                    products: batchProducts,
                    count: batchProducts.length
                });

                totalProducts += batchProducts.length;
            }

            processedStores += batch.length;

            send('progress', {
                batch_index: bi + 1,
                total_batches: batches.length,
                processed_stores: processedStores,
                total_stores: stores.length,
                total_products_so_far: totalProducts,
                percent: Math.round((processedStores / stores.length) * 100)
            });

            console.log(`✅ [all-products-stream] batch ${bi + 1}/${batches.length} — ${batchProducts.length} produk dikirim`);
        }

        send('done', {
            total_products: totalProducts,
            total_stores: stores.length,
            total_batches: batches.length
        });
        res.end();

    } catch (err) {
        console.error('❌ [all-products-stream]', err.message);
        send('error', { message: err.message });
        res.end();
    }
});

// ─────────────────────────────────────────────────────────────
// SSE: /api/apotek-products-stream?lat=&lng=
// ─────────────────────────────────────────────────────────────
app.get('/api/apotek-products-stream', async (req, res) => {
    const send = setupSSE(res);
    req.on('close', () => res.end());

    try {
        const userCoords = parseUserCoords(req.query);

        console.log(`📡 [apotek-products-stream] koordinat: ${userCoords.lat}, ${userCoords.lng}`);

        const stores = await fetchAllStoresFromComponent(APOTEK_COMPONENT_UID);
        const batches = chunk(stores, BATCH_SIZE);

        send('meta', {
            total_stores: stores.length,
            total_batches: batches.length,
            batch_size: BATCH_SIZE,
            source: 'apotek',
            userCoords
        });

        let totalProducts = 0;
        let processedStores = 0;

        for (let bi = 0; bi < batches.length; bi++) {
            const batch = batches[bi];
            const results = await processBatch(batch, userCoords, 'products');

            const batchProducts = [];

            results.forEach(r => {
                if (r.ok) {
                    batchProducts.push(...r.data);
                    console.log(`  ✅ ${r.store_title} → ${r.count || r.data.length} produk`);
                } else {
                    send('error_store', { store_name: r.store_title, error: r.error });
                    console.log(`  ⚠️  ${r.store_title}: ${r.error}`);
                }
            });

            if (batchProducts.length > 0) {
                batchProducts.sort((a, b) => (a.store_distance ?? Infinity) - (b.store_distance ?? Infinity));

                send('batch_products', {
                    batch_index: bi + 1,
                    total_batches: batches.length,
                    products: batchProducts,
                    count: batchProducts.length
                });

                totalProducts += batchProducts.length;
            }

            processedStores += batch.length;

            send('progress', {
                batch_index: bi + 1,
                total_batches: batches.length,
                processed_stores: processedStores,
                total_stores: stores.length,
                total_products_so_far: totalProducts,
                percent: Math.round((processedStores / stores.length) * 100)
            });

            console.log(`✅ [apotek-products-stream] batch ${bi + 1}/${batches.length} — ${batchProducts.length} produk dikirim`);
        }

        send('done', {
            total_products: totalProducts,
            total_stores: stores.length,
            total_batches: batches.length,
            source: 'apotek'
        });
        res.end();

    } catch (err) {
        console.error('❌ [apotek-products-stream]', err.message);
        send('error', { message: err.message });
        res.end();
    }
});

// ─────────────────────────────────────────────────────────────
// SSE: /api/makanan-products-stream?lat=&lng=
// ─────────────────────────────────────────────────────────────
app.get('/api/makanan-products-stream', async (req, res) => {
    const send = setupSSE(res);
    req.on('close', () => res.end());

    try {
        const userCoords = parseUserCoords(req.query);

        console.log(`📡 [makanan-products-stream] koordinat: ${userCoords.lat}, ${userCoords.lng}`);

        const stores = await fetchAllStoresFromComponent(MAKANAN_COMPONENT_UID);
        const batches = chunk(stores, BATCH_SIZE);

        send('meta', {
            total_stores: stores.length,
            total_batches: batches.length,
            batch_size: BATCH_SIZE,
            source: 'makanan',
            userCoords
        });

        let totalProducts = 0;
        let processedStores = 0;

        for (let bi = 0; bi < batches.length; bi++) {
            const batch = batches[bi];
            const results = await processBatch(batch, userCoords, 'products');

            const batchProducts = [];

            results.forEach(r => {
                if (r.ok) {
                    batchProducts.push(...r.data);
                    console.log(`  ✅ ${r.store_title} → ${r.count || r.data.length} produk`);
                } else {
                    send('error_store', { store_name: r.store_title, error: r.error });
                    console.log(`  ⚠️  ${r.store_title}: ${r.error}`);
                }
            });

            if (batchProducts.length > 0) {
                batchProducts.sort((a, b) => (a.store_distance ?? Infinity) - (b.store_distance ?? Infinity));

                send('batch_products', {
                    batch_index: bi + 1,
                    total_batches: batches.length,
                    products: batchProducts,
                    count: batchProducts.length
                });

                totalProducts += batchProducts.length;
            }

            processedStores += batch.length;

            send('progress', {
                batch_index: bi + 1,
                total_batches: batches.length,
                processed_stores: processedStores,
                total_stores: stores.length,
                total_products_so_far: totalProducts,
                percent: Math.round((processedStores / stores.length) * 100)
            });

            console.log(`✅ [makanan-products-stream] batch ${bi + 1}/${batches.length} — ${batchProducts.length} produk dikirim`);
        }

        send('done', {
            total_products: totalProducts,
            total_stores: stores.length,
            total_batches: batches.length,
            source: 'makanan'
        });
        res.end();

    } catch (err) {
        console.error('❌ [makanan-products-stream]', err.message);
        send('error', { message: err.message });
        res.end();
    }
});

// ─────────────────────────────────────────────────────────────
// SSE: /api/store/:viewUid/menu-stream
// ─────────────────────────────────────────────────────────────
app.get('/api/store/:viewUid/menu-stream', async (req, res) => {
    const send = setupSSE(res);
    req.on('close', () => res.end());

    try {
        const viewUid = req.params.viewUid;
        const userCoords = parseUserCoords(req.query);

        console.log(`📡 [menu-stream] store=${viewUid}`);

        const storeDetail = await fetchStoreDetail(viewUid);
        const categories = await fetchStoreCategories(viewUid);

        send('meta', {
            total_categories: categories.length,
            store_name: storeDetail.title,
            store_uid: viewUid
        });

        let totalProducts = 0;

        for (let i = 0; i < categories.length; i++) {
            const category = categories[i];
            const products = await fetchCategoryProducts(category.view_uid);

            const formattedProducts = products.map(product => {
                const distance = (storeDetail.origin_lat && storeDetail.origin_lng)
                    ? getDistance(userCoords.lat, userCoords.lng,
                        parseFloat(storeDetail.origin_lat), parseFloat(storeDetail.origin_lng))
                    : null;

                return {
                    view_uid: product.view_uid,
                    title: product.title,
                    image: product.image,
                    price: product.price || 0,
                    content: product.content || '',
                    category_name: category.title,
                    store_distance: distance,
                    has_variants: !!(product.list_product_variant && product.list_product_variant.length > 0),
                    variants: product.list_product_variant || []
                };
            });

            totalProducts += formattedProducts.length;

            send('category', {
                category_index: i + 1,
                total_categories: categories.length,
                category: {
                    view_uid: category.view_uid,
                    title: category.title,
                    products: formattedProducts
                }
            });

            send('progress', {
                percent: Math.round(((i + 1) / categories.length) * 100),
                current: i + 1,
                total: categories.length,
                products_loaded: totalProducts
            });

            console.log(`   ✅ ${category.title}: ${formattedProducts.length} produk`);
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        send('done', {
            total_categories: categories.length,
            total_products: totalProducts
        });
        res.end();

    } catch (err) {
        console.error('❌ [menu-stream]', err.message);
        send('error', { message: err.message });
        res.end();
    }
});

// ─────────────────────────────────────────────────────────────
// ENDPOINT JSON BIASA (non-SSE)
// ─────────────────────────────────────────────────────────────

/** GET /api/all-stores?lat=&lng= */
app.get('/api/all-stores', async (req, res) => {
    try {
        const userCoords = parseUserCoords(req.query);
        const stores = await fetchAllStoresFromComponent(STORE_COMPONENT_UID);
        const results = await processBatch(stores, userCoords, 'stores');
        const storeList = results.map(r => r.ok ? r.data : {
            view_uid: null,
            title: r.store_title,
            is_open: 0,
            close_status: 'Gagal load',
            origin_address: '',
            origin_lat: null,
            origin_lng: null,
            distance: null
        });
        storeList.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
        res.json({ success: true, stores: storeList, userCoords });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/** GET /api/all-products?lat=&lng= */
app.get('/api/all-products', async (req, res) => {
    try {
        const userCoords = parseUserCoords(req.query);
        const stores = await fetchAllStoresFromComponent(UWARUNG_COMPONENT_UID);
        const results = await processBatch(stores, userCoords, 'products');
        const allProducts = results.flatMap(r => r.ok ? r.data : []);
        allProducts.sort((a, b) => (a.store_distance ?? Infinity) - (b.store_distance ?? Infinity));
        res.json({
            success: true,
            total_products: allProducts.length,
            total_stores: stores.length,
            products: allProducts,
            userCoords
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/** GET /api/stores-from-uwarung */
app.get('/api/stores-from-uwarung', async (req, res) => {
    try {
        const userCoords = parseUserCoords(req.query);
        const stores = await fetchAllStoresFromComponent(UWARUNG_COMPONENT_UID);
        const results = await processBatch(stores, userCoords, 'stores');
        const storeList = results.filter(r => r.ok).map(r => r.data);
        res.json({ success: true, total_stores: storeList.length, stores: storeList });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/** GET /api/stores-from-apotek?lat=&lng= */
app.get('/api/stores-from-apotek', async (req, res) => {
    try {
        const userCoords = parseUserCoords(req.query);
        const stores = await fetchAllStoresFromComponent(APOTEK_COMPONENT_UID);
        const results = await processBatch(stores, userCoords, 'stores');
        const storeList = results.filter(r => r.ok).map(r => r.data);
        storeList.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
        res.json({ success: true, total_stores: storeList.length, stores: storeList, userCoords });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/** GET /api/apotek-products?lat=&lng= */
app.get('/api/apotek-products', async (req, res) => {
    try {
        const userCoords = parseUserCoords(req.query);
        const stores = await fetchAllStoresFromComponent(APOTEK_COMPONENT_UID);
        const results = await processBatch(stores, userCoords, 'products');
        const allProducts = results.flatMap(r => r.ok ? r.data : []);
        allProducts.sort((a, b) => (a.store_distance ?? Infinity) - (b.store_distance ?? Infinity));
        res.json({
            success: true,
            total_products: allProducts.length,
            total_stores: stores.length,
            products: allProducts,
            userCoords
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/** GET /api/stores-from-makanan?lat=&lng= */
app.get('/api/stores-from-makanan', async (req, res) => {
    try {
        const userCoords = parseUserCoords(req.query);
        const stores = await fetchAllStoresFromComponent(MAKANAN_COMPONENT_UID);
        const results = await processBatch(stores, userCoords, 'stores');
        const storeList = results.filter(r => r.ok).map(r => r.data);
        storeList.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
        res.json({ success: true, total_stores: storeList.length, stores: storeList, userCoords });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/** GET /api/makanan-products?lat=&lng= */
app.get('/api/makanan-products', async (req, res) => {
    try {
        const userCoords = parseUserCoords(req.query);
        const stores = await fetchAllStoresFromComponent(MAKANAN_COMPONENT_UID);
        const results = await processBatch(stores, userCoords, 'products');
        const allProducts = results.flatMap(r => r.ok ? r.data : []);
        allProducts.sort((a, b) => (a.store_distance ?? Infinity) - (b.store_distance ?? Infinity));
        res.json({
            success: true,
            total_products: allProducts.length,
            total_stores: stores.length,
            products: allProducts,
            userCoords
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/** GET /api/store/:viewUid */
app.get('/api/store/:viewUid', async (req, res) => {
    try {
        const detail = await fetchStoreDetail(req.params.viewUid);
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
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/** GET /api/store/:viewUid/products (VERSI FINAL - LENGKAP DENGAN KATEGORI) */
app.get('/api/store/:viewUid/products', async (req, res) => {
    try {
        const { viewUid } = req.params;
        const userCoords = parseUserCoords(req.query);

        console.log(`📦 [products] Fetching for store: ${viewUid}`);

        const [detail, categories] = await Promise.all([
            fetchStoreDetail(viewUid),
            fetchStoreCategories(viewUid)
        ]);

        // Hitung jarak
        const distance = (detail.origin_lat && detail.origin_lng)
            ? getDistance(userCoords.lat, userCoords.lng,
                parseFloat(detail.origin_lat), parseFloat(detail.origin_lng))
            : null;

        // Ambil semua produk dari semua kategori
        const allProducts = [];
        for (const category of categories) {
            const products = await fetchCategoryProducts(category.view_uid);
            products.forEach(product => {
                // Proses varian jika ada
                let variants = [];
                let displayPrice = product.price || 0;
                if (product.list_product_variant && product.list_product_variant.length > 0) {
                    variants = product.list_product_variant.map(v => ({
                        view_uid: v.view_uid,
                        name: v.name,
                        price: v.price || v.new_price || 0
                    }));
                    displayPrice = Math.min(...variants.map(v => v.price), displayPrice);
                }

                allProducts.push({
                    view_uid: product.view_uid,
                    title: product.title,
                    image: product.image,
                    price: displayPrice,
                    original_price: product.price_before_discount || product.price,
                    content: product.content || '',
                    product_category: category.title,
                    has_variants: variants.length > 0,
                    variants: variants,
                    store_view_uid: detail.view_uid,
                    store_title: detail.title,
                    store_distance: distance,
                    store_is_open: detail.is_open === 1,
                    is_open: product.is_open === 1,
                    max_qty: product.max_qty
                });
            });
            if (products.length > 0) {
                console.log(`   - ${category.title}: ${products.length} produk`);
            }
        }

        // Jika tidak ada kategori, coba ambil produk langsung dari toko
        if (categories.length === 0) {
            console.log(`   ⚠️ Tidak ada kategori, coba ambil produk langsung...`);
            const directProducts = await fetchCategoryProducts(viewUid);
            const produkLangsung = directProducts.filter(p => p.type === 0 || p.purchasable === 1);
            produkLangsung.forEach(product => {
                let variants = [];
                let displayPrice = product.price || 0;
                if (product.list_product_variant && product.list_product_variant.length > 0) {
                    variants = product.list_product_variant.map(v => ({
                        view_uid: v.view_uid,
                        name: v.name,
                        price: v.price || v.new_price || 0
                    }));
                    displayPrice = Math.min(...variants.map(v => v.price), displayPrice);
                }

                allProducts.push({
                    view_uid: product.view_uid,
                    title: product.title,
                    image: product.image,
                    price: displayPrice,
                    original_price: product.price_before_discount || product.price,
                    content: product.content || '',
                    product_category: 'Menu Utama',
                    has_variants: variants.length > 0,
                    variants: variants,
                    store_view_uid: detail.view_uid,
                    store_title: detail.title,
                    store_distance: distance,
                    store_is_open: detail.is_open === 1,
                    is_open: product.is_open === 1,
                    max_qty: product.max_qty
                });
            });
            if (produkLangsung.length > 0) {
                console.log(`   - Langsung: ${produkLangsung.length} produk`);
            }
        }

        // Kelompokkan berdasarkan kategori untuk response
        const productsByCategory = {};
        allProducts.forEach(p => {
            const cat = p.product_category;
            if (!productsByCategory[cat]) productsByCategory[cat] = [];
            productsByCategory[cat].push(p);
        });

        const categoriesResult = Object.keys(productsByCategory).map(catName => ({
            name: catName,
            products: productsByCategory[catName],
            count: productsByCategory[catName].length
        }));

        console.log(`✅ [products] Total ${allProducts.length} produk dari ${categoriesResult.length} kategori`);

        res.json({
            success: true,
            store: {
                view_uid: detail.view_uid,
                title: detail.title,
                origin_address: detail.origin_address || '',
                origin_lat: detail.origin_lat,
                origin_lng: detail.origin_lng,
                is_open: detail.is_open === 1,
                seller_rating: detail.seller_rating,
                image: detail.image
            },
            products: allProducts,
            categories: categoriesResult,
            total_products: allProducts.length,
            total_categories: categoriesResult.length,
            userCoords
        });

    } catch (err) {
        console.error('❌ [store products]', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`\n🚀 Server berjalan di port ${PORT}`);
    console.log(`\n━━━ ENDPOINT SSE (Batch ${BATCH_SIZE} toko) ━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`  📡 Toko Jastip  (SSE)   : GET /api/stores-stream?source=jastip&lat=...&lng=...`);
    console.log(`  📡 Toko UWarung (SSE)   : GET /api/stores-stream?source=uwarung&lat=...&lng=...`);
    console.log(`  📡 Toko Apotek  (SSE)   : GET /api/stores-stream?source=apotek&lat=...&lng=...`);
    console.log(`  📡 Toko Makanan (SSE)   : GET /api/stores-stream?source=makanan&lat=...&lng=...`);
    console.log(`  📡 Semua Produk (SSE)   : GET /api/all-products-stream?lat=...&lng=...`);
    console.log(`  📡 Produk Apotek(SSE)   : GET /api/apotek-products-stream?lat=...&lng=...`);
    console.log(`  📡 Produk Makanan(SSE)  : GET /api/makanan-products-stream?lat=...&lng=...`);
    console.log(`  📡 Menu Toko    (SSE)   : GET /api/store/:viewUid/menu-stream?lat=...&lng=...`);
    console.log(`\n━━━ ENDPOINT JSON (non-SSE) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`  🏪 Semua Toko Jastip    : GET /api/all-stores?lat=...&lng=...`);
    console.log(`  🏪 Semua Toko UWarung   : GET /api/stores-from-uwarung?lat=...&lng=...`);
    console.log(`  🏪 Semua Toko Apotek    : GET /api/stores-from-apotek?lat=...&lng=...`);
    console.log(`  🏪 Semua Toko Makanan   : GET /api/stores-from-makanan?lat=...&lng=...`);
    console.log(`  🛍️  Semua Produk        : GET /api/all-products?lat=...&lng=...`);
    console.log(`  💊 Produk Apotek        : GET /api/apotek-products?lat=...&lng=...`);
    console.log(`  🍔 Produk Makanan       : GET /api/makanan-products?lat=...&lng=...`);
    console.log(`  🏪 Detail Toko          : GET /api/store/:viewUid`);
    console.log(`  🍽️  Produk Toko         : GET /api/store/:viewUid/products?lat=...&lng=...`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
});