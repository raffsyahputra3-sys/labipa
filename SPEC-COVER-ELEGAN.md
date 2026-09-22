# 📋 SPESIFIKASI EKSEKUSI — Cover Elegan Lab IPA

## 0. Konteks Proyek

**File target:** `lab-ipa.html` (sudah ada, berisi simulator lab 3D lengkap) — di repo ini diterapkan ke `public/index.html` (+ sync `Game_Fix.html`).

**Tugas:** Mengganti **hanya** section `#cover` (start screen) dengan versi **elegan** — tetap pakai design language kertas-tinta (serif + mono), tapi dengan:

- Logo SVG inline (bukan file eksternal)
- Animasi masuk yang tenang (bukan flashy)
- Backsound stempel yang elegant (subtle, bukan berisik)
- Micro-interaction halus di tombol CTA

**Jangan sentuh:**
- Viewport 3D & semua logic Three.js
- Panel kanan (inventory, status, lampu, kendali)
- Overlay inventory (I)
- Sistem placement, physics, adhesive, snap
- Semua yang sudah berfungsi

## 1. Prinsip Desain — "Dokumen Resmi yang Dibuka Perlahan"

**Nada:** khidmat, tenang, seperti membuka **buku manual laboratorium** dari lemari arsip. Bukan splash screen SaaS, bukan intro sci-fi.

**Metafor:** cover dokumen pemerintah — stempel di atas, judul besar, kartu identitas, tombol "buka" seperti tombol fisik.

**Warna:** tetap dari palet yang sudah ada — kertas `#EDE7D3`, tinta `#1B2A41`, coklat aturan `#8B7355`, aksen safety `#D97706`, hijau chalk `#2E5C3E`.

**Tipografi:** EB Garamond (display) + IBM Plex Mono (label). Tidak ada font baru.

**Gerak:** semua entrance **fade + slide 12px ke atas**, dengan urutan 5 langkah. Tidak ada bounce, tidak ada rotate 360°, tidak ada scale 2×. Durasi total ≤ 1.6s.

**Suara:** **satu** file audio pendek (stempel thunk) — diputar saat user klik "Masuk Ruang Praktik", bukan saat load (autoplay policy).

## 2. Struktur HTML Cover Baru

Lihat kode di pesan spesifikasi asli (div#cover dengan logo SVG inline, judul, rule, lede, steps, spec, CTA btnStart, audio sfxStamp).

Adaptasi repo ini: multiplayer tabs (SOLO / BUAT ROOM / GABUNG ROOM + panel create/join + mpAvail) **dipertahankan** di dalam cover elegan agar fitur multiplayer + voice tidak rusak.

## 3. CSS — Animasi Elegan

Ditambahkan di akhir `<style>`: coverFadeUp, lineIn mask reveal, ruleGrow, stampPress, drawPath, fadeIn, bubbleRise, CTA arrow + glow, prefers-reduced-motion. Total durasi ≤ 1.6s. `.cover-cta` wajib `position:relative` untuk `::after` glow.

## 4. JavaScript — Backsound Stempel

Handler `btnStart` memutar `sfxStamp` (user gesture) + fallback Web Audio `playFallbackStamp()` bila file tidak ada / autoplay ditolak. Lalu menjalankan start logic yang sudah ada (`appStarted=true; updateCover(); setCamMode('orbit')`).

## 5. Timeline Animasi

Meta 0.05s → logo 0.10s → path labu 0.30s → judul baris 1 0.55s → baris 2 0.70s → rule 0.85s → lede 0.95s → steps 1.1s + stempel press 1.1s → cairan 1.2s → spec 1.25s → CTA 1.4s + bubble 1.4s → plus 1.5s. Suara saat klik.

## 6. Acceptance

Logo draw-line, judul mask reveal, stempel rotate+scale, CTA arrow +4px hover, suara saat klik (bukan load), durasi ≤1.6s, reduced-motion dihormati, no console error, cover lama hilang, viewport 3D tetap jalan.

## 7. Testing Manual

Buka, screenshot, tunggu 2s, hover CTA, klik (suara + cover hilang + viewport + lock), refresh, console, reduce motion.

## 8. Tidak boleh diubah

:root vars, #stage, Three.js, #panel, #inventory, listener keyboard selain btnStart, shortcuts.

## 9. Konflik CSS

Hapus definisi lama yang konflik, pakai yang baru. Verifikasi `cover-cta{` satu definisi.
