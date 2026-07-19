# 토지이용 AR (obstacle-camera)

토지이용계획도(VWorld `lt_c_lhblpn`)를 카메라 화면 위에 **증강현실**로 겹쳐 보여주는
모바일 웹앱. GPS·나침반 센서로 저장된 지점의 **거리·방위**를 실시간 표시하고, AR 정보를
함께 합성한 사진을 촬영·저장합니다.

- 라이브: **https://arcam.3chan.kr**
- 원본 디자인: claude.ai/design 프로젝트 "토지이용도 기반 증강현실 앱"의 `토지이용 AR.dc.html`

## 기능

| 탭 | 설명 |
|----|------|
| **카메라** | 후면 카메라 위에 지점 핀·화면밖 화살표·나침반 밴드·크로스헤어를 오버레이. 셔터로 AR 합성 사진 촬영. |
| **지도** | Leaflet(OSM) 지도 + VWorld 토지이용계획도 오버레이(투명도 조절). 지도를 눌러 지점 추가, 마커를 눌러 삭제. |
| **지점** | 저장된 지점을 내 위치 기준 거리·방위와 함께 목록으로. 이름 변경·삭제. |
| **사진** | 촬영한 AR 사진 갤러리. 열기·삭제. |
| **설정** | 데모/실측 모드 전환, 카메라·위치·방향 권한 요청. |

**데모 모드**: 권한 없이도 가상 위치(서울시청)와 방향 슬라이더로 AR을 미리 볼 수 있습니다.
실기기에서 카메라·위치·방향 권한을 허용하면 자동으로 실측 모드로 전환됩니다.

## PWA · 설치 안내

이 앱은 **설치형 PWA**입니다. 홈 화면에 추가하면 주소창 없는 전체 화면으로 실행되고,
서비스 워커가 앱 셸을 캐시해 오프라인/약전계에서도 화면이 즉시 뜹니다.

- **웹 앱 매니페스트**(`html/manifest.webmanifest`): 이름·아이콘(192·512 PNG, `any`/`maskable` 분리)·
  `display: standalone`·테마색. Chrome 안드로이드 설치 요건을 충족합니다.
- **서비스 워커**(`html/sw.js`): 같은 출처 앱 셸 + Leaflet/Pretendard CDN을 캐시(cache-first),
  페이지 이동은 network-first(오프라인 시 캐시된 셸). 지도 타일(OSM·VWorld)은 캐시하지 않습니다.
  ※ Chrome 108+에선 설치에 서비스 워커가 필수가 아니므로, 설치를 이 파일에 의존시키지 않습니다.
- **아이콘**(`html/icons/`): 순수 파이썬으로 생성한 PNG(다크 플레이트 + 위치핀). `apple-touch-icon`은
  불투명 180×180.
- **설치/홈추가 안내 UX**(`index.html` 하단 `<script>`): 플랫폼을 감지해 상황별 바텀시트를 띄웁니다.
  - **안드로이드 · 크롬**: `beforeinstallprompt`를 잡아 **원탭 설치** 버튼(네이티브 프롬프트).
  - **안드로이드 · 크롬 아님**(삼성인터넷·파폭 등): **크롬 사용 권장** + `intent://…;package=com.android.chrome`로 크롬 열기.
  - **인앱 브라우저**(카카오톡·네이버·인스타 등 웹뷰): 기능 제한 안내 + **크롬으로 열기**/‘다른 브라우저로 열기’. iOS 카카오톡은 `kakaotalk://web/openExternal` 원탭 탈출.
  - **iOS · Safari**: **‘공유 → 홈 화면에 추가’** 단계 안내.
  - 이미 설치되어 standalone으로 실행 중이면 안내를 숨깁니다. ‘설정’ 탭에서 언제든 다시 열 수 있습니다.
- **standalone 안전영역**: 홈 화면 실행 시에만(`@media (display-mode: standalone)`) `env(safe-area-inset-*)`
  여백을 줘 상단 칩·나침반이 노치에, 하단 탭바가 홈 인디케이터에 가리지 않게 합니다. 브라우저 탭 실행에는 영향 없음.

## 구현 메모

- 원본은 claude.ai Design의 **DC(Design Component)** 포맷(프리뷰용 `support.js` 런타임 + React 의존)
  이었습니다. 이 저장소는 그 런타임 의존성을 제거하고 **의존성 없는 단일 파일 웹앱**
  (`html/index.html`, 순수 JS + Leaflet CDN)으로 포팅한 결과입니다. 마크업·인라인 스타일·로직은
  원본과 동일하게 유지했습니다.
- 카메라(`getUserMedia`)·위치(`geolocation`)·방향(`DeviceOrientation`) 센서는 **HTTPS(보안 컨텍스트)**
  에서만 동작합니다. 프로덕션은 Caddy가 Let's Encrypt 인증서로 HTTPS를 제공합니다.
- 외부 의존: Leaflet 1.9.4(unpkg), Pretendard 폰트(jsDelivr), OSM 타일, VWorld WMS.

### VWorld 토지이용계획도 오버레이 관련

지도 오버레이 타일은 VWorld 공개 서비스(`map.vworld.kr/proxy.do` → `2d.vworld.kr/2DCache`)를
그대로 사용합니다. 이 공개 프록시는 호출량 제한이 있어 간헐적으로 타일이 비어 보일 수 있습니다.
안정적인 프로덕션 사용이 필요하면 [VWorld 오픈API 키](https://www.vworld.kr/dev/v4dv_apikey_s001.do)를
`arcam.3chan.kr` 도메인으로 발급받아 WMS 요청에 붙이는 방식으로 교체하는 것을 권장합니다.

## 배포

이 VM의 공유 리버스 프록시 규칙을 그대로 따릅니다.

- 앱: `nginx:alpine`이 `html/`을 서빙, 외부 `web` 네트워크에 `arcam-app` 별칭으로 참여.
- 프록시: `/srv/proxy`의 Caddy가 `arcam.3chan.kr` → `arcam-app:80`으로 리버스 프록시(+자동 HTTPS).

```bash
# 1) 앱 스택 기동/갱신
cd /srv/obstacle-camera
docker compose up -d

# 2) (최초 1회) Caddy 사이트 블록 추가 후 리로드
#    /srv/proxy/Caddyfile 에 아래 블록이 있어야 합니다:
#
#    arcam.3chan.kr {
#        encode zstd gzip
#        reverse_proxy arcam-app:80
#    }
#
docker compose -f /srv/proxy/docker-compose.yml exec caddy caddy reload --config /etc/caddy/Caddyfile

# 3) html/ 내용만 바꿨을 때: 디렉터리 마운트라 재기동 없이 즉시 반영됩니다.
#    (index.html·sw.js·manifest는 no-cache 헤더라 새로고침 즉시 최신 버전 로드)
```

> **nginx/default.conf 를 고쳤다면** 컨테이너 재시작이 필요합니다. 단일 파일 바인드
> 마운트는 편집 시 inode가 바뀌어 `nginx -s reload`만으로는 새 설정이 반영되지 않습니다
> (Caddyfile과 같은 함정). `docker restart arcam_app` 로 재시작하세요.

> **서비스 워커 갱신**: `sw.js`의 `CACHE` 버전 문자열을 올리면 다음 방문 때 옛 캐시가
> 정리되고 새 셸을 받습니다. `sw.js`는 `no-cache`로 서빙되어 워커 자체는 항상 최신을 확인합니다.

`arcam.3chan.kr` DNS는 이미 이 VM(`5.78.221.121`)을 가리키는 와일드카드로 설정되어 있습니다.

## 구조

```
obstacle-camera/
├─ html/
│  ├─ index.html            # 앱 전체 (단일 파일) + PWA 설치/홈추가 안내
│  ├─ manifest.webmanifest  # 웹 앱 매니페스트
│  ├─ sw.js                 # 서비스 워커 (앱 셸 오프라인 캐시)
│  └─ icons/                # PWA 아이콘(192·512 any/maskable) + apple-touch-icon
├─ nginx/
│  └─ default.conf          # 정적 서빙 + 캐시/보안 헤더 (sw.js·매니페스트·아이콘 포함)
├─ docker-compose.yml       # nginx + web 네트워크(arcam-app 별칭)
└─ README.md
```
