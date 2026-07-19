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

# 3) 내용만 바꿨을 때: 파일은 read-only 마운트라 재기동 없이 즉시 반영됩니다.
#    (index.html은 no-cache 헤더라 새로고침 즉시 최신 버전 로드)
```

`arcam.3chan.kr` DNS는 이미 이 VM(`5.78.221.121`)을 가리키는 와일드카드로 설정되어 있습니다.

## 구조

```
obstacle-camera/
├─ html/
│  └─ index.html          # 앱 전체 (단일 파일)
├─ nginx/
│  └─ default.conf        # 정적 서빙 + 캐시/보안 헤더
├─ docker-compose.yml     # nginx + web 네트워크(arcam-app 별칭)
└─ README.md
```
