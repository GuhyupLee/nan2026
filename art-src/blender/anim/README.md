# Blender IK 캐릭터 애니메이션 — **아직 배포에 쓰지 않는다**

## 상태

파이프라인은 끝까지 돌아간다. 리그·저작·베이크·VRMA 변환이 전부 동작하고
결정적이다. 그런데 **결과 모션이 게임의 동작 계약과 어긋난다.**

`ranged.attack`의 `start` 단계에서 `leftUpperArm`이 설계 포즈
(`src/render/animation-data.ts`의 `VRM_ACTION_MOTIONS`) 대비 약 2.19rad(≈125°)
차이가 난다. 예비동작으로 설명되는 범위가 아니다 — 팔이 다른 쪽을 향한다.

가장 유력한 원인은 **Blender Z-up → VRM Y-up 변환**이다. 특히 어깨·상완처럼
레스트 포즈가 축에 정렬되지 않은 본에서 축 순서나 부호가 뒤집히면 정확히
이런 크기의 오차가 나온다. `clips.py`의 베이크 단계에서 로컬 회전을
꺼내는 부분을 먼저 의심하라.

## 왜 배포하지 않았는가

두 가지가 동시에 맞아야 내보낼 수 있다.

1. 자동 검증 — `tools/animation-check.ts`가 지키던 것은 "VRMA가 게임이 선언한
   동작과 일치한다"는 계약이다. 이 검사를 **Blender 베이크와 대조하도록
   바꾸면 통과하지만, 그건 같은 출처끼리 비교하는 것이라 아무것도 보장하지
   않는다.** 칼을 반대로 휘둘러도 통과한다.
2. 눈 — 자동화된 브라우저 탭에서는 캐릭터 선택을 거치지 않아 VRM이 로드되지
   않는다. 그래서 이 모션을 실제로 본 사람이 아직 없다.

둘 다 없는 상태로 18개 전투 클립을 교체하면, 게임의 손맛과 이펙트 타이밍이
어긋났을 때 원인을 여기까지 되짚기 어렵다. 원본은 그대로 두고 파이프라인만
남겼다.

기존 클립 백업: `backup/myeongwol-combat.pre-blender.vrma`
(현재 `public/animations/myeongwol-combat.vrma`와 동일하다.)

## 다시 시도할 때

```bash
node tools/blender/run.mjs art-src/blender/anim/clips.py   # out/*.json 생성
npx tsx tools/vrma-from-blender.ts                         # VRMA로 변환
npm run check:animation                                    # 계약 검사
```

`check:animation`은 **원래 형태를 유지하고 있다** — `animation-data.ts`와
대조한다. 그 검사가 통과하면 그때 교체하면 된다. 검사를 고쳐서 통과시키지 마라.

좌표 변환을 고친 뒤에는 각 본의 최대 오차를 출력해 보는 편이 빠르다.
한 본만 틀렸으면 그 본의 레스트 축 문제이고, 전부 비슷하게 틀렸으면
전역 변환 행렬 문제다.
