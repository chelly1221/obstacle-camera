# 토지이용 AR (obstacle-camera)

토지이용계획도(VWorld `lt_c_lhblpn`)를 카메라 화면 위에 **증강현실**로 겹쳐 보여주는
모바일 웹앱. GPS·나침반 센서로 저장된 건물의 **거리·방위**를 실시간 표시하고, AR 정보를
함께 합성한 사진을 촬영·저장합니다.

- 라이브: **https://arcam.3chan.kr**
- 원본 디자인: claude.ai/design 프로젝트 "토지이용도 기반 증강현실 앱"의 `토지이용 AR.dc.html`

## 기능

| 탭 | 설명 |
|----|------|
| **카메라** | 후면 카메라 실제 화면 위에 건물 핀·화면밖 화살표·나침반 밴드·크로스헤어를 오버레이. 나침반은 저역통과 보간으로 부드럽게 회전(깜박임 없음). 셔터로 AR 합성 사진 촬영. |
| **지도** | Leaflet(OSM) 지도 + VWorld 토지이용계획도 오버레이(투명도 조절). 지도를 누르면 **이름·그룹을 바로 지정**하는 시트로 건물 추가, 마커를 눌러 편집. 최초 1회만 내 위치로 이동(이후 자동 이동 없음, ‘내 위치로’ 버튼은 수동). |
| **건물** | 서버에 **공유 저장**된 건물을 **그룹별**로, 내 위치 기준 거리·방위와 함께 목록으로. 그룹 추가/이름변경/색변경/삭제, 건물 편집·삭제. 표시숨김(눈)만 기기별 로컬. |
| **사진** | 촬영한 AR 사진을 **서버에 공유 저장**하는 갤러리. 1:1 썸네일(중앙 크롭)로 보여주고, 열기·삭제. **선택 모드**로 다중/전체 선택 후 **다운로드**(1장이면 JPEG 바로, 여러 장이면 ZIP). |
| **설정** | 카메라·위치·방향 권한 요청, 홈 화면 설치 안내. |

**실측 전용**: 데모 모드는 제거되었습니다. 카메라·위치(GPS)·방향(나침반) 권한을 허용하면
실제 화면 위에 건물이 표시됩니다.

**건물·그룹은 서버에 공유 저장**됩니다(아래 [건물 공유 저장소](#건물-공유-저장소-백엔드-api) 참고).
링크(`arcam.3chan.kr`)를 여는 **모든 기기가 같은 건물 목록**을 보고, 한 기기에서 추가·수정·삭제하면
다른 기기에도 반영됩니다(15초 폴링 + 탭 복귀 시 즉시). 접근 제어는 없습니다 — 링크를 아는 누구나
보기·편집이 가능합니다. localStorage는 이제 **오프라인/최초 페인트용 캐시**로만 쓰이고, **그룹 ‘숨김’
(눈 아이콘)만 기기별 로컬 설정**으로 남습니다. 마지막 지도 위치도 기기별 로컬입니다. **촬영 사진도 이제 서버 공유**입니다 — 모든 기기가 같은 갤러리를 봅니다(아래 API 참고).

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

## 건물 공유 저장소 (백엔드 API)

건물·그룹을 모든 기기가 공유하도록 **의존성 없는 작은 Node 백엔드**(`backend/server.js`)를 둡니다.

- **저장**: 건물·그룹을 원자적 JSON 파일 하나(`data/store.json`, 바인드 마운트로 재시작·재배포에도 유지)에
  기록합니다. `id`는 **서버가 발급**해 기기 간 충돌을 없앱니다. `rev`(ETag)로 저렴한 폴링을 지원합니다.
- **API**(모두 `/api/` 아래, nginx가 프록시): `GET /state`(ETag→변경 없으면 304), `POST/PUT/DELETE /points`,
  `POST /points/clear`, `POST/PUT/DELETE /groups`, `POST /import`(서버가 비었을 때만 로컬 데이터 1회 이관), `GET /health`.
- **사진 API**: 사진은 건물 store와 **완전히 분리** 저장합니다 — 원본/썸네일 JPEG은 파일로(`data/photos/<id>.jpg`,
  `<id>.t.jpg`), 메타 색인만 `data/photos.json`에. 그래서 잦은 건물 저장이 대용량 이미지로 느려지지 않습니다.
  엔드포인트: `GET /photos`(ETag 폴링), `GET /photos/<id>[/thumb]`(JPEG 서빙, `?dl=1`이면 첨부 다운로드),
  `POST /photos`(본문 `[썸네일][원본]` 이진, 경계는 `X-Thumb-Len` 헤더, `?uid=`는 재업로드 **멱등키**),
  `DELETE /photos/<id>`, `POST /photos/zip`(선택/전체를 **무압축 ZIP**으로 스트리밍 — 외부 라이브러리 없음).
  클라이언트는 촬영 즉시 낙관적 미리보기를 띄우고 백그라운드 업로드하며, **오프라인이면 IndexedDB 큐**에 담아
  재접속 시 재시도합니다(사진 유실 방지). 사진도 건물처럼 **모든 기기 공유 + 15초 폴링**입니다.
- **접근 제어 없음(공개)** — 검증(위경도 범위·이름 길이·색상·JPEG 매직바이트)과 상한(건물 1만·그룹 500개·본문
  1MB, 사진 1장 10MB·총 5천장·ZIP 500장/3GB)으로만 보호합니다.
  쓰기 잠금이 필요하면 `docker-compose.yml`의 `WRITE_KEY` 환경변수와 `index.html`의 `API_KEY`를 같은 값으로 설정하세요
  (클라이언트에 키가 노출되므로 강한 보안은 아니고, 무단 편집 억제용).
- **경로 격리**: nginx가 `/api/*`를 백엔드로 프록시하고, 백엔드는 **비공개 `internal` 네트워크**에만 있어
  Caddy·인터넷에서 직접 접근할 수 없습니다(오직 nginx를 통해서만).
- **클라이언트 동기화**: 서버가 원본. 부팅 시 서버에서 받아오고, 보이는 동안 15초마다 + 탭 복귀·온라인 복귀 시
  즉시 폴링합니다. 모든 쓰기는 API 호출 후 서버 상태로 재동기화합니다. 서버 도입 전부터 브라우저에 있던
  로컬 건물은 서버가 비어 있을 때 **최초 1회 자동 이관**됩니다.

## 배포

이 VM의 공유 리버스 프록시 규칙을 그대로 따릅니다.

- 앱: `nginx:alpine`이 `html/`을 서빙, 외부 `web` 네트워크에 `arcam-app` 별칭으로 참여.
- API: `node:22-alpine`이 `backend/server.js`를 실행, **비공개 `internal` 네트워크**로 nginx와만 통신.
  nginx가 `/api/*` → `backend:8080`으로 프록시(런타임 DNS resolver + `/api` 접두어 제거).
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
│  ├─ index.html            # 앱 전체 (단일 파일) + PWA 설치/홈추가 안내 + 서버 동기화
│  ├─ manifest.webmanifest  # 웹 앱 매니페스트
│  ├─ sw.js                 # 서비스 워커 (앱 셸 오프라인 캐시)
│  └─ icons/                # PWA 아이콘(192·512 any/maskable) + apple-touch-icon
├─ backend/
│  └─ server.js             # 건물·그룹 공유 저장소 API (의존성 없는 Node HTTP 서버)
├─ data/                    # 런타임 저장(store.json + photos.json + photos/) — gitignore, 서버에만 존재
├─ nginx/
│  └─ default.conf          # 정적 서빙 + /api 프록시 + 캐시/보안 헤더
├─ docker-compose.yml       # nginx(web·arcam-app) + backend(internal) + data 볼륨
└─ README.md
```
