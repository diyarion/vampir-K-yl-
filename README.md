# Gece Köyü

Tarayıcıdan oynanan, Türkçe Vampir Köylü oyunu. Oda koduyla katılımı, 50 oyuncuya kadar odaları, gerçek zamanlı sohbeti ve sunucu tarafından yönetilen oyun turlarını destekler.

## Yerelde çalıştırma

Node.js 20 veya üzeri gerekir.

```powershell
npm install
npm start
```

Tarayıcıda `http://localhost:3000` adresini aç. Sunucu aynı ağdaki cihazlardan erişim için `0.0.0.0` üzerinde dinler. İnternet üzerinden oynamak için uygulamayı herkese açık bir Node.js hosting servisine dağıt.

## Oyun kuralları

- Oda kurucusu 5 karakterli kodu paylaşır; oda 50 oyuncuyla sınırlıdır.
- Oyun en az 4 kişiyle başlar. Oyuncu sayısına göre vampir, köylü, dedektif ve doktor rolleri dağıtılır; 8+ kişide avcı da eklenir.
- Gece vampirler hedef seçer, doktor korur ve dedektif bir kişiyi gizlice araştırır. Gündüz herkes tartışır ve oy kullanır.
- Vampirler hayatta kalanların en az yarısına ulaşırsa vampirler; hiç vampir kalmazsa köylüler kazanır.
- Gündüz sohbeti herkese açıktır; gece sohbetini sadece vampirler görür. Oyun eylemleri sunucu tarafından doğrulanır.

## İnternete dağıtım

Render için `render.yaml` hazırdır: depoyu GitHub'a gönderip Render'da **New > Blueprint** ile depoyu seç. Servis Node uygulamasını kurar ve `/healthz` ile sağlık kontrolü yapar. Alternatif olarak `Dockerfile` herhangi bir Docker uyumlu hostta kullanılabilir.

Oda durumu sunucu belleğinde tutulur; tek çalışan örnekte odalar eşzamanlı çalışır. Sunucu yeniden başlatılırsa devam eden odalar kapanır. Birden fazla uygulama örneği açılacaksa Socket.IO için paylaşımlı adapter ve oturum yönlendirmesi eklenmelidir.

## Test

```powershell
npm test
```
