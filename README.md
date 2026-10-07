# tefas-crawler

TEFAS'taki yatırım fonlarının günlük verilerini yerel bir SQLite veritabanında arşivleyen ve her gün kendiliğinden güncel tutan bir TypeScript/Node.js komut satırı aracı.

- Seçilen fon türündeki tüm fonların son 5 yıllık günlük verisini (fiyat, pay sayısı, yatırımcı sayısı, toplam değer) çeker; fon listesi API'den otomatik gelir.
- API'nin "sorgu başına en fazla 1 ay" ve "en fazla 5 yıl geriye" kısıtları, aralığın ay sınırlarına bölünmesi ve kayan 5 yıllık pencereye göre kırpılmasıyla aşılır.
- HTTP 429 alındığında yalnızca isteği tekrarlamakla kalmaz; tüm koşunun istek aralığını adaptif olarak açar (üstel backoff, 60 sn tavan) ve başarılı isteklerle kademeli olarak geri iner.
- Fon kodu + tarih anahtarlı idempotent upsert: tekrar çalıştırmak çift kayıt üretmez, TEFAS'ın sonradan yaptığı düzeltmeler yakalanır. Her dönemin sonucu `fetch_log` tablosuna yazılır; kesilen iş kaldığı yerden devam eder.
- Tek çalışma zamanı bağımlılığı `better-sqlite3`; CSV ve XLSX dışa aktarımı (XLSX için minimal OOXML + ZIP yazıcı) projenin kendi kodudur.

---

## Özellikler

- İlk kurulumda **son 5 yılın** günlük verisini çeker.
- Sonrasında her gün yalnızca **eksik günleri** tamamlar.
- Aynı fon ve tarih için tek kayıt tutar (upsert); TEFAS veriyi düzeltirse kayıt güncellenir.
- Başarısız dönemleri kaydeder; bunlar daha sonra tekrar denenebilir.
- CSV ve Excel (.xlsx) olarak dışa aktarır.

---

## Veri kaynağı

TEFAS'ın **kendi web arayüzünün kullandığı JSON API** kullanılır; HTML scraping yapılmaz:

```
POST https://www.tefas.gov.tr/api/funds/fonGnlBlgSiraliGetir
```

| Alan (API) | Veritabanı sütunu | Dışa aktarım başlığı |
|---|---|---|
| `tarih` | `date` | Tarih |
| `fonKodu` | `fund_code` | Fon Kodu |
| `fonUnvan` | `fund_name` | Fon Adı |
| `fiyat` | `price` | Fiyat |
| `tedPaySayisi` | `share_count` | Tedavüldeki Pay Sayısı |
| `kisiSayisi` | `investor_count` | Kişi Sayısı |
| `portfoyBuyukluk` | `total_value` | Fon Toplam Değer |
| `borsaBultenFiyat` | `exchange_bulletin_price` | Borsa Bülten Fiyatı |

**Borsa Bülten Fiyatı yalnızca borsa yatırım fonlarında (BYF) doludur.** TEFAS bu alanı
yatırım fonları için yayımlamaz ve kendi sitesinde de bu sütunu göstermez. Dışa aktarım,
tamamen boş kalan sütunları dosyaya yazmaz; BYF verisi eklendiğinde sütun kendiliğinden
geri gelir.

Fon listesi **otomatik** olarak gelir: sorgu, verilen tarih aralığında verisi olan tüm fonları döndürür. Fon kodu girmeye gerek yoktur.

### API'nin dayattığı kısıtlar

Bunlar bizim tercihimiz değil, TEFAS'ın kuralları; kod bunlara göre yazıldı:

| Kısıt | API yanıtı | Koddaki karşılığı |
|---|---|---|
| Tek sorguda en fazla **1 takvim ayı** | `"Geçersiz veri: Tarih aralığı 1 ayı aşamaz"` | `monthlyChunks()` aralığı ay sınırlarına böler |
| Başlangıç tarihi **5 yıldan eski olamaz** | `"Geçersiz veri: Baslangıc Tarihi 5 yıldan eski olamaz"` | `earliestAllowedStart()`; sınır kayarsa aralık otomatik olarak kırpılır |
| **Rate limit** var | `ERR-224 "Because of reaching Throttling limit"` (HTTP 429) | İstekler arası gecikme + üstel backoff + **adaptif yavaşlama** |
| Hafta sonu / tatil | `"Index 0 out of bounds for length 0"` | Hata sayılmaz, `empty` olarak işaretlenir |

TEFAS, sürekli yüksek hacme karşı throttling uyguladığı için yalnızca başarısız isteği tekrarlamak yetmez.
429 alındığında **tüm koşunun** istek aralığı iki katına çıkar (en az 5 sn, tavan 60 sn); sonraki başarılı
isteklerde kademeli olarak `TEFAS_REQUEST_DELAY_MS` değerine geri iner.

> **Önemli:** 5 yıl **kayan** bir penceredir. Bugün çekilmeyen eski veri yarın artık hiç çekilemez.
> Veritabanı zamanla TEFAS'ın kendi sunduğundan daha derin hale gelir; **yedek alın, kaybolan veri geri getirilemez.**

---

## Kurulum

Node.js 22 veya üstü gerekir.

```bash
npm install
```

İsteğe bağlı ayarlar için `.env.example` dosyasını `.env` adıyla kopyalayın. Hiçbir ayar zorunlu değildir.

---

## Kullanım

### İlk kurulum: 5 yıllık geçmiş

```bash
npm run backfill
```

Yaklaşık 60 aylık istek demektir; yatırım fonları (`YAT`) için yaklaşık 30 dakika sürer ve 1,7 milyon civarında satır üretir. **Kesintiye uğrarsa komutu yeniden çalıştırın:** tamamlanan aylar `fetch_log` tablosundan okunup atlanır, iş kaldığı yerden devam eder.

### Günlük güncelleme

```bash
npm run daily
```

Veritabanındaki en son tarihten bugüne kadarki eksikleri tamamlar. Sistem günlerce kapalı kalsa bile açıldığında aradaki boşluğu kendisi kapatır. En son kayıtlı gün bilerek yeniden çekilir; böylece TEFAS'ın sonradan yaptığı düzeltmeler de yakalanır.

### Durum

```bash
npm run status
```

Örnek çıktı:

```
Veri tabanı: <proje dizini>/data/tefas.db

YAT: 1.668.009 satır, 2062 fon, 2021-08-13 -> 2026-08-14

Başarısız dönem yok.
```

### Başarısız dönemleri tekrar deneme

```bash
npm run retry-failed
```

### Belirli bir aralığı elle çekme

```bash
npm run cli -- fetch --from=2026-07-01 --to=2026-07-31
```

### Dışa aktarım

```bash
# Tümü, CSV
npm run cli -- export --format=csv --out=exports/tumu.csv

# Türkçe Excel için (noktalı virgül ayırıcı + virgüllü ondalık)
npm run cli -- export --format=csv --delimiter=";" --decimal-comma --out=exports/tumu.csv

# Tek fon, Excel
npm run cli -- export --format=xlsx --fund-code=AAL --out=exports/aal.xlsx

# Tarih aralığı
npm run cli -- export --from=2026-01-01 --to=2026-08-13
```

`--out` verilmezse dosya `exports/tefas-<bugün>.<uzantı>` adıyla yazılır. `npm run export -- <seçenekler>` kısayolu da aynı komutu çalıştırır. Tüm komutlar ve seçenekler için: `npm run cli -- --help`.

Sütun başlıkları Türkçedir ve TEFAS'ın kendi sitesindeki adlandırmayla aynıdır.
Excel dosyalarında sütun genişlikleri, sayı biçimleri (fiyat 6 ondalık, tutarlar binlik
ayırıcılı), kalın başlık satırı, dondurulmuş üst satır ve filtre düğmeleri hazır gelir.
Bu biçimlendirme olmazsa Excel büyük tutarları `6,8E+10` gibi bilimsel gösterime çevirir.
CSV dosyaları UTF-8 BOM ile yazılır; böylece Excel Türkçe karakterleri doğru okur.
XLSX biçiminin kendi sınırı nedeniyle bir Excel dosyasına en fazla 1.048.575 veri satırı yazılabilir; tam arşiv için CSV kullanın.

---

## Otomatik günlük çalıştırma

### Windows (Görev Zamanlayıcı)

```powershell
npm run build
powershell -ExecutionPolicy Bypass -File scripts\register-daily-task.ps1
```

Her gün 20:00'de çalışan `TefasDailyUpdate` adlı bir zamanlanmış görev oluşturur. Saati değiştirmek için:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\register-daily-task.ps1 -Time 21:30
```

Görev `StartWhenAvailable` seçeneğiyle kurulur: bilgisayar o saatte kapalıysa açıldığında çalışır; kaçırılan günleri crawler zaten kendisi tamamlar.

Kaldırmak için:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\register-daily-task.ps1 -Unregister
```

Hemen bir kez çalıştırmak için:

```powershell
Start-ScheduledTask -TaskName TefasDailyUpdate
```

### Linux (systemd)

`deploy/` klasöründe örnek systemd birimleri bulunur. Birimler, projenin `/opt/tefas` altında, `tefas` kullanıcısıyla ve `npm run build` sonrasında `dist/cli.js` üzerinden çalışacağı varsayımıyla yazılmıştır:

- `tefas-daily.service` + `tefas-daily.timer`: her gün 20:00'de (Europe/Istanbul) `daily` komutunu çalıştırır.
- `tefas-retry.service` + `tefas-retry.timer`: her gece 02:30'da `retry-failed` komutunu çalıştırır.

Farklı bir dizin veya kullanıcı kullanıyorsanız birim dosyalarındaki yolları uyarlayın.

---

## Veritabanı

Varsayılan konum: `data/tefas.db` (SQLite, WAL modunda).

### `fund_daily`

| Sütun | Tip | |
|---|---|---|
| `fund_code` | TEXT | **PK** |
| `date` | TEXT | **PK** |
| `fund_type` | TEXT | `YAT` / `EMK` / `BYF` |
| `fund_name` | TEXT | |
| `price` | REAL | |
| `share_count` | REAL | |
| `investor_count` | INTEGER | |
| `total_value` | REAL | |
| `exchange_bulletin_price` | REAL | |
| `created_at` / `updated_at` | TEXT | `updated_at` yalnızca bir değer gerçekten değiştiyse ilerler |

Birincil anahtar `(fund_code, date)`; aynı fon ve tarih için ikinci bir kayıt oluşmaz.

Her komutun sonunda WAL dosyası veritabanına geri aktarılır; bu nedenle **yedek almak için `data/tefas.db` dosyasını tek başına kopyalamak yeterlidir** (komut çalışırken kopyalamayın). Yatırım fonlarının 5 yıllık arşivi yaklaşık 380 MB tutar.

### `fetch_log`

Her tarih aralığının sonucunu tutar: `success` / `empty` / `failed`, satır sayısı, deneme sayısı, hata türü ve mesajı. Backfill'in kaldığı yerden devam edebilmesi ve `retry-failed` komutu bu tabloya dayanır.

---

## Loglar

`logs/tefas-<tarih>.log`: her gün için ayrı bir dosya. Aynı satırlar konsola da yazılır.

```
2026-08-14T16:48:18.631Z INFO  Dönem çekiliyor | fonTuru=YAT donem=2026-08-14..2026-08-14 ilerleme=1/1
2026-08-14T16:48:20.228Z INFO  Dönem kaydedildi | fonTuru=YAT donem=2026-08-14..2026-08-14 cekilen=2032 yeni=0 guncellenen=0 degismeyen=2032
```

Çıkış kodları: `0` başarılı, `2` en az bir dönem başarısız (zamanlayıcıda alarm kurmak için kullanılabilir), `1` komut veya ayar hatası.

---

## Ayarlar

Tüm ayarlar `.env` üzerinden verilir ve hepsi isteğe bağlıdır. Ayrıntılar için `.env.example` dosyasına bakın.

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `TEFAS_DB_PATH` | `data/tefas.db` | Göreli yollar proje köküne göre çözülür |
| `TEFAS_LOG_DIR` | `logs` | Log dosyalarının klasörü |
| `TEFAS_FUND_TYPES` | `YAT` | `YAT,EMK,BYF` biçiminde birden fazla tür verilebilir |
| `TEFAS_HISTORY_YEARS` | `5` | API zaten 5 yılda kesiyor |
| `TEFAS_REQUEST_DELAY_MS` | `3000` | İstekler arası en kısa bekleme |
| `TEFAS_MAX_RETRIES` | `5` | Bir dönem için en fazla yeniden deneme sayısı |
| `TEFAS_RETRY_BASE_MS` | `10000` | Üstel backoff tabanı |
| `TEFAS_THROTTLE_COOLDOWN_MS` | `60000` | 429 sonrası bekleme tabanı |
| `TEFAS_TIMEOUT_MS` | `180000` | Bir aylık yanıt ~10 MB'tır ve ~26 sn sürer |
| `TEFAS_PAGE_SIZE` | `60000` | Bir ay ~45.000 satırdır; tek istekte bir ayın tamamı gelir |
| `TEFAS_API_URL` | TEFAS endpoint'i | Endpoint değişirse güncellenir |
| `TEFAS_API_TOKEN` | — | İsteğe bağlı; yalnızca TEFAS bearer token istemeye başlarsa gerekir |

### Diğer fon türleri

```bash
npm run cli -- backfill --fund-type=EMK    # emeklilik yatırım fonları
npm run cli -- backfill --fund-type=BYF    # borsa yatırım fonları
```

Kalıcı hale getirmek için `.env` içine `TEFAS_FUND_TYPES=YAT,EMK,BYF` yazın.

---

## Geliştirme

```bash
npm run typecheck   # tsc --noEmit
npm run build       # dist/ altına derler
```

---

## Proje yapısı

```
src/
  cli.ts               Komutlar (backfill / daily / fetch / retry-failed / status / export)
  config.ts            .env + varsayılanlar
  logger.ts            Konsol + dosya logu
  types.ts             Alan tipleri
  core/ingest.ts       Orkestrasyon: planlama, chunk döngüsü, özet
  tefas/
    client.ts          HTTP, rate limit, retry/backoff
    errors.ts          TEFAS hata mesajlarının sınıflandırılması
    mapper.ts          API yanıtı -> veritabanı kaydı
  db/
    connection.ts      SQLite bağlantısı
    schema.ts          Migration'lar (PRAGMA user_version)
    repository.ts      Upsert ve sorgular
  export/
    csv.ts             Akış (stream) halinde CSV
    xlsx.ts            Minimal OOXML
    zip.ts             Minimal ZIP (xlsx için; ek bağımlılık gerektirmemek adına)
  util/
    dates.ts           Tarih aritmetiği ve aylık bölme
    sleep.ts           Bekleme ve jitter yardımcıları
scripts/
  register-daily-task.ps1   Windows zamanlanmış görevi
deploy/                     systemd service ve timer birimleri
```

Yeni bir fon türü veya alan eklerken değiştirilecek yerler: `types.ts`, `tefas/mapper.ts`, `db/schema.ts`.

---

## Bakım notu

Kullanılan API **belgelenmemiş** bir uçtur. Sitenin görünümü değişse bile bozulmaz; ancak TEFAS backend'ini yenilerse endpoint veya alan adları değişebilir. Nitekim bir önceki uç (`/api/DB/BindHistoryInfo`) kapatılmıştır.

Bozulma durumunda değiştirilmesi gereken yerler:

- Endpoint: `.env` içinde `TEFAS_API_URL`
- İstek gövdesi: `src/tefas/client.ts` → `buildPayload()`
- Alan adları: `src/tefas/mapper.ts` → `mapRows()`

---

## Yasal not

- Bu proje resmi değildir; Takasbank veya TEFAS ile herhangi bir bağlantısı yoktur.
- Çekilen verilerin hakları sahiplerine aittir. Bu depo herhangi bir fon verisi içermez; veritabanı yalnızca aracı çalıştıran kişinin kendi bilgisayarında oluşur.
- Proje kişisel kullanım ve eğitim amacıyla geliştirilmiştir. TEFAS'ın kullanım koşullarına uymak kullanıcının sorumluluğundadır.
- Sunucuya yük bindirmemek için istekler bilinçli olarak yavaşlatılır (istekler arası bekleme, 429 alındığında adaptif yavaşlama).

---

## Lisans

MIT. Ayrıntılar için [`LICENSE`](LICENSE) dosyasına bakın.
