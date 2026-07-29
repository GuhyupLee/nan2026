import type { AudioSettings, GameAudio } from '../audio.ts'
import type { InputState } from '../input.ts'
import {
  GLOW_MAX,
  GLOW_MIN,
  getGlowIntensity,
  setGlowIntensity,
} from '../render/glow-settings.ts'
import { trapFocus } from './focus-trap.ts'

export type PauseAction = 'resume' | 'menu'

type VolumeKey = 'master' | 'music' | 'sfx'

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value))

async function unlockAndPreview(audio: GameAudio): Promise<void> {
  try {
    await audio.unlock()
    audio.preview()
  } catch {
    // 오디오 출력 장치가 없거나 브라우저가 막아도 설정 UI 자체는 계속 쓸 수 있다.
  }
}

function makeButton(className: string, label: string, hint?: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.className = className
  button.type = 'button'

  const text = document.createElement('span')
  text.textContent = label
  button.appendChild(text)

  if (hint) {
    const small = document.createElement('small')
    small.textContent = hint
    button.appendChild(small)
  }
  return button
}

/**
 * 게임 중 오른쪽 위에 머무는 일시정지 진입 버튼.
 * 키보드의 Enter/Space는 네이티브 button 동작을 그대로 사용한다.
 */
export class PauseButton {
  private readonly element: HTMLButtonElement
  private readonly handleClick: () => void
  private disposed = false

  constructor(parent: HTMLElement, onClick: () => void) {
    this.element = document.createElement('button')
    this.element.className = 'pause-button'
    this.element.type = 'button'
    this.element.setAttribute('aria-label', '일시정지 메뉴 열기')

    const icon = document.createElement('span')
    icon.className = 'pause-icon'
    icon.setAttribute('aria-hidden', 'true')
    icon.textContent = 'Ⅱ'
    this.element.appendChild(icon)

    const label = document.createElement('span')
    label.className = 'pause-label'
    label.textContent = '일시정지'
    this.element.appendChild(label)

    this.handleClick = () => {
      if (!this.disposed) onClick()
    }
    this.element.addEventListener('click', this.handleClick)
    parent.appendChild(this.element)
  }

  setVisible(visible: boolean): void {
    if (this.disposed) return
    this.element.hidden = !visible
    this.element.disabled = !visible
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.element.removeEventListener('click', this.handleClick)
    this.element.remove()
  }
}

/**
 * 오디오와 스킬 시전 방식을 함께 다루는 설정 모달.
 *
 * 슬라이더 input은 지연 없이 설정을 적용하고, change와 명시적 버튼 조작은
 * 사용자 제스처 안에서 오디오 잠금을 해제한 뒤 짧은 확인음을 낸다.
 */
export function showSettings(
  parent: HTMLElement,
  audio: GameAudio,
  input: InputState,
): Promise<void> {
  return new Promise((resolve) => {
    const initial = audio.getSettings()
    let muted = initial.muted

    const root = document.createElement('div')
    root.className = 'settings-overlay'
    root.setAttribute('role', 'dialog')
    root.setAttribute('aria-modal', 'true')
    root.setAttribute('aria-labelledby', 'settings-title')

    const panel = document.createElement('section')
    panel.className = 'settings-panel'
    root.appendChild(panel)

    const heading = document.createElement('header')
    heading.className = 'menu-heading'
    heading.innerHTML =
      '<div class="menu-eyebrow">게임 설정</div>' +
      '<h2 id="settings-title">설정</h2>' +
      '<p>전투 소리와 화면 밝기, 스킬 시전 방식을 바로 조절할 수 있습니다.</p>'
    panel.appendChild(heading)

    const fields = document.createElement('div')
    fields.className = 'settings-fields'
    panel.appendChild(fields)

    const addVolume = (
      key: VolumeKey,
      label: string,
      description: string,
      value: number,
    ): HTMLInputElement => {
      const row = document.createElement('label')
      row.className = 'settings-volume'

      const copy = document.createElement('span')
      copy.className = 'settings-copy'
      const name = document.createElement('strong')
      name.textContent = label
      const detail = document.createElement('small')
      detail.textContent = description
      copy.append(name, detail)

      const output = document.createElement('output')
      output.className = 'settings-value'

      const slider = document.createElement('input')
      slider.type = 'range'
      slider.min = '0'
      slider.max = '100'
      slider.step = '1'
      slider.value = String(Math.round(clamp01(value) * 100))
      slider.setAttribute('aria-label', label)

      const apply = (): void => {
        const next = Number(slider.value) / 100
        output.value = `${slider.value}%`
        const patch: Partial<AudioSettings> =
          key === 'master'
            ? { master: next }
            : key === 'music'
              ? { music: next }
              : { sfx: next }
        audio.setSettings(patch)
      }

      apply()
      slider.addEventListener('input', apply)
      slider.addEventListener('change', () => {
        apply()
        void unlockAndPreview(audio)
      })

      row.append(copy, output, slider)
      fields.appendChild(row)
      return slider
    }

    const master = addVolume(
      'master',
      '마스터 음량',
      '게임의 모든 소리를 함께 조절합니다.',
      initial.master,
    )
    addVolume('music', '배경 음악', '메뉴와 전투 음악의 크기입니다.', initial.music)
    addVolume('sfx', '효과음', '공격, 피격, 스킬 소리의 크기입니다.', initial.sfx)

    const mute = makeButton('settings-toggle', '음소거')
    const muteState = document.createElement('small')
    muteState.className = 'toggle-state'
    mute.appendChild(muteState)

    const renderMute = (): void => {
      mute.setAttribute('aria-pressed', String(muted))
      mute.dataset.active = String(muted)
      muteState.textContent = muted ? '켜짐' : '꺼짐'
    }
    renderMute()
    mute.addEventListener('click', () => {
      muted = !muted
      audio.setSettings({ muted })
      renderMute()
      void unlockAndPreview(audio)
    })
    fields.appendChild(mute)

    // 발광 강도.
    //
    // 이 게임은 어두운 아레나에서 발광으로 정보를 전달하는데, 한 화면에 열
    // 개 넘게 겹치면 눈이 아프다. `prefers-reduced-motion`은 움직임만 줄여
    // 이 축을 덮지 못하므로 별도 슬라이더를 둔다.
    //
    // 완전히 끄지 못하게 하한(35%)이 있다. 보스 돌진 예고선이 안 보이면
    // 그건 접근성이 아니라 난이도 상승이다.
    {
      const row = document.createElement('label')
      row.className = 'settings-volume'

      const copy = document.createElement('span')
      copy.className = 'settings-copy'
      copy.innerHTML =
        '<strong>발광 강도</strong>' +
        '<small>스킬과 이펙트의 번짐, 화면이 물드는 정도를 줄입니다. ' +
        '경고와 범위 표시는 항상 보입니다.</small>'

      const output = document.createElement('output')
      output.className = 'settings-value'

      const slider = document.createElement('input')
      slider.type = 'range'
      slider.min = String(Math.round(GLOW_MIN * 100))
      slider.max = String(Math.round(GLOW_MAX * 100))
      slider.step = '5'
      slider.value = String(Math.round(getGlowIntensity() * 100))
      slider.setAttribute('aria-label', '발광 강도')

      const apply = (): void => {
        const next = Number(slider.value) / 100
        output.value = `${slider.value}%`
        // 전투 중(일시정지)에도 열리므로 즉시 반영한다. 닫을 때 적용하면
        // 사용자는 값을 보고 고르는 게 아니라 짐작해서 고르게 된다.
        setGlowIntensity(next)
      }
      apply()
      slider.addEventListener('input', apply)

      row.append(copy, output, slider)
      fields.appendChild(row)
    }

    const aimAssist = makeButton(
      'settings-toggle',
      '약한 조준 보정 · 커서 가까운 적만 보정',
    )
    const aimAssistState = document.createElement('small')
    aimAssistState.className = 'toggle-state'
    aimAssist.appendChild(aimAssistState)
    let aimAssistEnabled = input.getAimAssist()

    const renderAimAssist = (): void => {
      aimAssist.setAttribute('aria-pressed', String(aimAssistEnabled))
      aimAssist.dataset.active = String(aimAssistEnabled)
      aimAssistState.textContent = aimAssistEnabled ? '켜짐' : '꺼짐'
    }
    renderAimAssist()
    aimAssist.addEventListener('click', () => {
      aimAssistEnabled = !aimAssistEnabled
      input.setAimAssist(aimAssistEnabled)
      renderAimAssist()
    })
    fields.appendChild(aimAssist)

    const controls = document.createElement('fieldset')
    controls.className = 'cast-mode-settings'
    const legend = document.createElement('legend')
    legend.textContent = '시전 방식'
    controls.appendChild(legend)

    const castModeList = document.createElement('div')
    castModeList.className = 'cast-mode-list'
    castModeList.setAttribute('role', 'radiogroup')
    castModeList.setAttribute('aria-label', '스킬 시전 방식')
    controls.appendChild(castModeList)

    const castOptions = [
      {
        mode: 'instant' as const,
        label: '즉시 시전',
        description: '누르면 바로 발동',
      },
      {
        mode: 'release' as const,
        label: '일반 시전',
        description: '누르는 동안 범위를 표시하고 떼면 발동',
      },
    ]
    const castRadios: HTMLInputElement[] = []

    const renderCastMode = (): void => {
      const current = input.getCastMode()
      for (const radio of castRadios) {
        radio.checked = radio.value === current
        radio.closest<HTMLElement>('.cast-mode-option')!.dataset.active = String(radio.checked)
      }
    }

    for (const option of castOptions) {
      const label = document.createElement('label')
      label.className = 'cast-mode-option'

      const radio = document.createElement('input')
      radio.type = 'radio'
      radio.name = 'cast-mode'
      radio.value = option.mode
      radio.setAttribute('aria-label', `${option.label}: ${option.description}`)
      castRadios.push(radio)

      const marker = document.createElement('span')
      marker.className = 'cast-mode-marker'
      marker.setAttribute('aria-hidden', 'true')

      const copy = document.createElement('span')
      copy.className = 'cast-mode-copy'
      const name = document.createElement('strong')
      name.textContent = option.label
      const description = document.createElement('small')
      description.textContent = option.description
      copy.append(name, description)

      radio.addEventListener('change', () => {
        if (!radio.checked) return
        input.setCastMode(option.mode)
        renderCastMode()
      })

      label.append(radio, marker, copy)
      castModeList.appendChild(label)
    }
    renderCastMode()
    panel.appendChild(controls)

    const actions = document.createElement('div')
    actions.className = 'settings-actions'
    panel.appendChild(actions)

    const preview = makeButton('menu-button settings-preview', '테스트 사운드', '현재 음량 확인')
    preview.addEventListener('click', () => void unlockAndPreview(audio))
    actions.appendChild(preview)

    const back = makeButton('menu-button primary settings-back', '뒤로', 'ESC')
    actions.appendChild(back)

    let done = false
    let releaseFocusTrap = (): void => {}
    const close = (): void => {
      if (done) return
      done = true
      window.removeEventListener('keydown', onKey)
      releaseFocusTrap()
      root.remove()
      resolve()
    }

    const onKey = (event: KeyboardEvent): void => {
      if (event.repeat || event.key !== 'Escape') return
      event.preventDefault()
      close()
    }

    back.addEventListener('click', close)
    window.addEventListener('keydown', onKey)
    parent.appendChild(root)
    releaseFocusTrap = trapFocus(root)
    master.focus()
  })
}

/**
 * 게임을 멈춘 동안 표시하는 메뉴.
 *
 * 설정을 여는 동안 이 모달의 ESC 리스너를 떼어, 설정의 ESC 한 번이
 * 일시정지까지 동시에 닫는 중복 처리로 이어지지 않게 한다.
 */
export function showPause(
  parent: HTMLElement,
  audio: GameAudio,
  input: InputState,
): Promise<PauseAction> {
  return new Promise((resolve) => {
    const root = document.createElement('div')
    root.className = 'pause-overlay'
    root.setAttribute('role', 'dialog')
    root.setAttribute('aria-modal', 'true')
    root.setAttribute('aria-labelledby', 'pause-title')

    const panel = document.createElement('section')
    panel.className = 'pause-panel'
    root.appendChild(panel)

    const heading = document.createElement('header')
    heading.className = 'menu-heading'
    heading.innerHTML =
      '<div class="menu-eyebrow">게임 일시정지</div>' +
      '<h2 id="pause-title">일시정지</h2>' +
      '<p>전장은 멈춰 있습니다.</p>'
    panel.appendChild(heading)

    const actions = document.createElement('div')
    actions.className = 'pause-actions'
    panel.appendChild(actions)

    const resume = makeButton('menu-button primary', '계속하기', 'ESC')
    const settings = makeButton('menu-button', '설정', '오디오와 조작')
    const menu = makeButton('menu-button danger', '메인 메뉴', '확인 후 전투 종료')
    actions.append(resume, settings, menu)

    const confirmation = document.createElement('section')
    confirmation.className = 'pause-confirmation menu-heading'
    confirmation.hidden = true
    confirmation.setAttribute('aria-labelledby', 'pause-confirm-title')
    confirmation.innerHTML =
      '<div class="menu-eyebrow">전투 종료 확인</div>' +
      '<h2 id="pause-confirm-title">메인 메뉴로 나갈까요?</h2>' +
      '<p>진행 중인 전투는 종료됩니다. 이번 전투의 점수와 보상은 저장되지 않습니다.</p>'

    const confirmActions = document.createElement('div')
    confirmActions.className = 'pause-actions pause-confirm-actions'
    const cancelExit = makeButton(
      'menu-button primary pause-confirm-cancel',
      '취소',
      '일시정지 메뉴로 돌아가기',
    )
    const confirmExit = makeButton(
      'menu-button danger pause-confirm-exit',
      '전투 종료',
      '메인 메뉴로 이동',
    )
    confirmActions.append(cancelExit, confirmExit)
    confirmation.appendChild(confirmActions)
    panel.appendChild(confirmation)

    let done = false
    let settingsOpen = false
    let confirmingExit = false
    let releaseFocusTrap = (): void => {}

    const finish = (action: PauseAction): void => {
      if (done) return
      done = true
      window.removeEventListener('keydown', onKey)
      releaseFocusTrap()
      root.remove()
      resolve(action)
    }

    const setConfirmingExit = (confirming: boolean): void => {
      if (done || settingsOpen) return
      confirmingExit = confirming
      root.dataset.confirmingExit = String(confirming)
      heading.hidden = confirming
      actions.hidden = confirming
      confirmation.hidden = !confirming
      root.setAttribute(
        'aria-labelledby',
        confirming ? 'pause-confirm-title' : 'pause-title',
      )
      if (confirming) cancelExit.focus()
      else menu.focus()
    }

    const onKey = (event: KeyboardEvent): void => {
      if (event.repeat || event.key !== 'Escape' || settingsOpen) return
      event.preventDefault()
      if (confirmingExit) {
        setConfirmingExit(false)
        return
      }
      finish('resume')
    }

    const openSettings = async (): Promise<void> => {
      if (done || settingsOpen) return
      settingsOpen = true
      window.removeEventListener('keydown', onKey)
      releaseFocusTrap()
      root.hidden = true
      try {
        await showSettings(parent, audio, input)
      } finally {
        settingsOpen = false
        if (!done) {
          root.hidden = false
          window.addEventListener('keydown', onKey)
          releaseFocusTrap = trapFocus(root)
          settings.focus()
        }
      }
    }

    resume.addEventListener('click', () => finish('resume'))
    settings.addEventListener('click', () => void openSettings())
    menu.addEventListener('click', () => setConfirmingExit(true))
    cancelExit.addEventListener('click', () => setConfirmingExit(false))
    confirmExit.addEventListener('click', () => finish('menu'))
    window.addEventListener('keydown', onKey)
    parent.appendChild(root)
    releaseFocusTrap = trapFocus(root)
    resume.focus()
  })
}
