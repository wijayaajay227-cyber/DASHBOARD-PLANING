# Dashboard Planning Server

## Perbaikan pada versi ini
1. **Nama file dashboard** — server sekarang otomatis mendukung `Dashboard Planning.html` maupun `Dashboard_Planning.html`. Sebelumnya server error terus karena nama file tidak cocok persis.
2. **Cookie sesi aman untuk HTTPS** — otomatis menambahkan atribut `Secure` saat diakses lewat HTTPS (dibutuhkan untuk deployment online).
3. **Kode undangan pendaftaran (opsional)** — kalau dashboard sudah bisa diakses lewat internet, sebaiknya pendaftaran tidak dibiarkan terbuka untuk siapa saja yang menemukan link-nya. Aktifkan dengan environment variable `REGISTRATION_CODE`; tim harus memasukkan kode ini di form "Daftar Baru".

## Menjalankan di PC kantor (LAN)

```powershell
node server.js
```

Dashboard terbuka di `http://localhost:3000` pada PC server. Perangkat lain di jaringan kantor buka `http://ALAMAT-IP-PC-SERVER:3000`. Izinkan Node.js menerima koneksi TCP port 3000 di Windows Firewall bila perlu.

Untuk mengaktifkan kode undangan pendaftaran:

```powershell
$env:REGISTRATION_CODE="kode-rahasia-kalian"; node server.js
```

## Akun tim

Pilih **Daftar Baru**, masukkan NIK karyawan (4-32 angka) dan password minimal 8 karakter (plus kode undangan kalau diaktifkan). Setelah terdaftar, anggota tim memakai NIK dan password yang sama untuk login. Data Jobshop dan Stock tersimpan bersama di folder `server-data` pada mesin yang menjalankan server. `server-data/users.json` menyimpan hash password, bukan password asli.

## Membuat dashboard bisa diakses online (bukan cuma LAN kantor)

PC kantor dengan port-forwarding router **tidak disarankan** untuk pemakaian rutin: tidak ada HTTPS bawaan, tergantung PC menyala terus, dan alamat IP rumah/kantor bisa berubah-ubah. Cara yang lebih andal: deploy `server.js` ke layanan hosting kecil yang otomatis menyediakan HTTPS.

**Opsi termudah — Render.com (ada paket gratis):**
1. Push folder ini ke repository GitHub (jangan sertakan folder `server-data`, sudah ada di `.gitignore`).
2. Di Render, buat **Web Service** baru dari repo tersebut.
3. Build command: (kosongkan/tidak perlu). Start command: `node server.js`.
4. Tambahkan environment variable `REGISTRATION_CODE` dengan kode rahasia kalian.
5. **Penting:** paket gratis Render/PaaS sejenis biasanya memakai *ephemeral disk* — file di `server-data/` bisa hilang saat server di-redeploy atau tidur lama karena tidak ada trafik. Untuk data yang harus permanen, tambahkan **Persistent Disk** (biasanya berbayar, mulai beberapa dolar/bulan) dan arahkan ke folder `server-data`.

**Alternatif:** Railway.app atau Fly.io — caranya mirip (deploy dari Git, set start command `node server.js`, environment variable, dan aktifkan persistent volume untuk folder `server-data`).

**Untuk uji coba cepat tanpa deploy dulu:** jalankan server seperti biasa di PC, lalu gunakan tunnel sementara seperti Cloudflare Tunnel atau ngrok untuk dapat link HTTPS publik sementara — cocok untuk demo, bukan pemakaian jangka panjang.

## Batas keamanan yang masih perlu diperhatikan
- Tidak ada pembatasan percobaan login (*rate limiting*) — untuk pemakaian publik jangka panjang, sebaiknya tambahkan pembatasan agar tidak mudah ditebak-tebak (brute force).
- Data tersimpan sebagai file JSON biasa, bukan database sungguhan — cukup untuk tim kecil, tapi tidak akan bertahan baik untuk ratusan pengguna bersamaan atau kebutuhan riwayat perubahan.
- Selalu jalankan lewat HTTPS begitu online; jangan biarkan versi HTTP polos diakses dari internet karena password bisa tersadap saat transit.
