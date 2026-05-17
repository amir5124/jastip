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
const GOOGLE_API_KEY = 'AIzaSyCxfdljVSgNFeQKfEzNzeUJUuJVxSxntVQ';

// Default koordinat (Sepaku, Kalimantan Timur)
let defaultCoords = { lat: -0.975, lng: 116.786 }; // Sepaku, Nusantara

// Hitung jarak haversine (km)
function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
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
        const stores = lists.data || [];
        allStores.push(...stores);
        lastPage = lists.last_page;
        currentPage++;
    } while (currentPage <= lastPage);
    return allStores;
}

// Ambil detail toko (alamat, koordinat, dll)
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

// Endpoint utama: terima query lat, lng (opsional)
app.get('/api/all-stores', async (req, res) => {
    try {
        // Ambil koordinat dari query parameter, jika tidak ada pakai default
        let userLat = parseFloat(req.query.lat);
        let userLng = parseFloat(req.query.lng);
        let userCoords = null;
        if (!isNaN(userLat) && !isNaN(userLng)) {
            userCoords = { lat: userLat, lng: userLng };
            console.log(`📍 Menggunakan koordinat user: ${userLat}, ${userLng}`);
        } else {
            userCoords = defaultCoords;
            console.log(`📍 Menggunakan koordinat default (Sepaku): ${defaultCoords.lat}, ${defaultCoords.lng}`);
        }

        // Ambil semua toko dari component
        const stores = await fetchAllStoresFromComponent();
        console.log(`📋 Total toko dari component: ${stores.length}`);

        const storesWithDetail = [];
        for (const store of stores) {
            try {
                const detail = await fetchStoreDetail(store.view_uid);
                const distance = (userCoords && detail.origin_lat && detail.origin_lng)
                    ? getDistance(userCoords.lat, userCoords.lng, detail.origin_lat, detail.origin_lng)
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

        // Urutkan berdasarkan jarak (null di akhir)
        storesWithDetail.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));

        res.json({ success: true, stores: storesWithDetail, userCoords });
    } catch (error) {
        console.error('❌ Error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Backend berjalan di port ${PORT}`);
});