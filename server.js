const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.static('public'));

// Konfigurasi
const COMPONENT_VIEW_UID = '618e70133c5ca';  // dari URL contoh
const CODENAME = 'iknlinku';
const GOOGLE_API_KEY = 'AIzaSyCxfdljVSgNFeQKfEzNzeUJUuJVxSxntVQ';

// Koordinat Batang (Jawa Tengah) – bisa juga diambil dari geocoding
let batangCoords = null;

// Fungsi untuk mendapatkan koordinat Batang dari Google (sekali saat startup)
async function initBatangCoords() {
    try {
        const url = `https://maps.googleapis.com/maps/api/geocode/json?address=Batang, Indonesia&key=${GOOGLE_API_KEY}`;
        const response = await axios.get(url);
        if (response.data.status === 'OK' && response.data.results.length) {
            const loc = response.data.results[0].geometry.location;
            batangCoords = { lat: loc.lat, lng: loc.lng };
            console.log(`📍 Koordinat Batang: ${batangCoords.lat}, ${batangCoords.lng}`);
        } else {
            console.warn('Gagal mendapatkan koordinat Batang, gunakan default');
            batangCoords = { lat: -6.894, lng: 110.694 }; // fallback
        }
    } catch (err) {
        console.error('Error geocoding Batang:', err.message);
        batangCoords = { lat: -6.894, lng: 110.694 };
    }
}

// Hitung jarak haversine (km)
function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Ambil semua toko dari component (semua halaman)
async function fetchAllStoresFromComponent() {
    let allStores = [];
    let currentPage = 1;
    let lastPage = 1;

    do {
        const url = `https://app.jagel.id/api/v2/customer/component/${COMPONENT_VIEW_UID}?codename=${CODENAME}&page=${currentPage}&app_mode=1&per_page=24`;
        console.log(`🌐 Fetch component page ${currentPage}: ${url}`);
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
        const stores = lists.data || [];
        allStores.push(...stores);
        lastPage = lists.last_page;
        currentPage++;
        console.log(`  📦 Dapat ${stores.length} toko, total sementara ${allStores.length}`);
    } while (currentPage <= lastPage);

    return allStores;
}

// Ambil detail toko (termasuk alamat dan koordinat)
async function fetchStoreDetail(viewUid) {
    const url = `https://app.jagel.id/api/v2/customer/list/${viewUid}?codename=${CODENAME}`;
    console.log(`🔍 Fetch detail for ${viewUid}`);
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

// Endpoint utama yang mengembalikan semua toko dengan jarak dari Batang
app.get('/api/all-stores', async (req, res) => {
    try {
        console.log('\n🚀 Memulai fetch semua toko...');
        // 1. Ambil semua toko dari component
        const stores = await fetchAllStoresFromComponent();
        console.log(`📋 Total toko dari component: ${stores.length}`);

        // 2. Untuk setiap toko, ambil detail (koordinat, alamat, dll)
        const storesWithDetail = [];
        for (const store of stores) {
            try {
                const detail = await fetchStoreDetail(store.view_uid);
                const distance = (batangCoords && detail.origin_lat && detail.origin_lng)
                    ? getDistance(batangCoords.lat, batangCoords.lng, detail.origin_lat, detail.origin_lng)
                    : null;
                storesWithDetail.push({
                    view_uid: store.view_uid,
                    title: store.title,
                    image: store.image,
                    content: detail.content || '',
                    is_open: detail.is_open,
                    close_status: detail.close_status || '',
                    origin_address: detail.origin_address || '',
                    origin_lat: detail.origin_lat,
                    origin_lng: detail.origin_lng,
                    link_view: store.link_view,
                    distance: distance,
                    seller_rating: detail.seller_rating
                });
                console.log(`  ✅ ${store.title} - jarak: ${distance?.toFixed(2)} km`);
            } catch (err) {
                console.error(`  ❌ Gagal detail untuk ${store.view_uid}: ${err.message}`);
                // tetap masukkan tanpa jarak
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

        // 3. Urutkan berdasarkan jarak (yang null di akhir)
        storesWithDetail.sort((a, b) => {
            if (a.distance === null && b.distance === null) return 0;
            if (a.distance === null) return 1;
            if (b.distance === null) return -1;
            return a.distance - b.distance;
        });

        console.log(`✅ Selesai, total ${storesWithDetail.length} toko terurut.\n`);
        res.json({ success: true, stores: storesWithDetail });
    } catch (error) {
        console.error('❌ Error di /api/all-stores:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Jalankan server
app.listen(PORT, async () => {
    console.log(`\n🚀 Proxy server berjalan di http://localhost:${PORT}`);
    console.log(`📦 Frontend: http://localhost:${PORT}`);
    await initBatangCoords();
    console.log(`✅ Siap melayani request\n`);
});