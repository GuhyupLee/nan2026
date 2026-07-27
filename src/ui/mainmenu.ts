/**
 * 키아트를 전면에 둔 메인 메뉴.
 *
 * 별도 카드나 대시보드 껍데기 없이, 왼쪽 선택지와 오른쪽 인물 구도를
 * 한 화면에 고정해 게임의 첫 인상을 바로 전달한다.
 */
export function showMainMenu(
  parent: HTMLElement,
  onSettings: () => Promise<void> | void,
): Promise<void> {
  return new Promise((resolve) => {
    const root = document.createElement('div')
    root.className = 'mainmenu'
    root.setAttribute('role', 'dialog')
    root.setAttribute('aria-modal', 'true')
    root.setAttribute('aria-labelledby', 'mainmenu-title')

    const keyart = document.createElement('img')
    keyart.className = 'mainmenu-keyart'
    keyart.src = `${import.meta.env.BASE_URL}art/main-menu-keyart.webp`
    keyart.alt = ''
    keyart.decoding = 'async'
    keyart.fetchPriority = 'high'
    root.appendChild(keyart)

    const shade = document.createElement('div')
    shade.className = 'mainmenu-shade'
    shade.setAttribute('aria-hidden', 'true')
    root.appendChild(shade)

    const content = document.createElement('main')
    content.className = 'mainmenu-content'
    root.appendChild(content)

    const eyebrow = document.createElement('div')
    eyebrow.className = 'mainmenu-eyebrow'
    eyebrow.textContent = 'ACTION SURVIVAL'
    content.appendChild(eyebrow)

    const titleRow = document.createElement('div')
    titleRow.className = 'mainmenu-title-row'
    content.appendChild(titleRow)

    const mark = document.createElement('img')
    mark.className = 'mainmenu-mark'
    mark.src = `${import.meta.env.BASE_URL}art/myeongwol-mark.webp`
    mark.alt = ''
    mark.decoding = 'async'
    titleRow.appendChild(mark)

    const title = document.createElement('h1')
    title.id = 'mainmenu-title'
    title.textContent = '명월'
    titleRow.appendChild(title)

    const tagline = document.createElement('p')
    tagline.className = 'mainmenu-tagline'
    tagline.textContent = '달은 원을 파고, 해는 선을 긋는다.'
    content.appendChild(tagline)

    const rule = document.createElement('div')
    rule.className = 'mainmenu-rule'
    rule.setAttribute('aria-hidden', 'true')
    content.appendChild(rule)

    const actions = document.createElement('div')
    actions.className = 'mainmenu-actions'
    content.appendChild(actions)

    const start = document.createElement('button')
    start.className = 'mainmenu-action primary'
    start.type = 'button'
    start.innerHTML = '<span>게임 시작</span><small>ENTER</small>'
    actions.appendChild(start)

    const settings = document.createElement('button')
    settings.className = 'mainmenu-action'
    settings.type = 'button'
    settings.innerHTML = '<span>설정</span><small>오디오 · 조작</small>'
    actions.appendChild(settings)

    let done = false
    let settingsOpen = false

    const finish = (): void => {
      if (done || settingsOpen) return
      done = true
      root.classList.add('closing')
      window.setTimeout(() => {
        root.remove()
        resolve()
      }, 220)
    }

    const openSettings = async (): Promise<void> => {
      if (done || settingsOpen) return
      settingsOpen = true
      try {
        await onSettings()
      } finally {
        settingsOpen = false
        if (!done) settings.focus()
      }
    }

    start.addEventListener('click', finish)
    settings.addEventListener('click', () => void openSettings())
    parent.appendChild(root)
    start.focus()
  })
}
