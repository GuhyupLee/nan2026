/**
 * 균일 격자 공간 해시.
 *
 * 적 수백 마리의 이웃 질의(분리 밀어내기, 스킬 판정)를 O(n²)에서 끌어내린다.
 * 물리 엔진을 쓰지 않기로 한 결정이 성립하려면 이게 있어야 한다.
 *
 * 매 틱 통째로 재구축한다. 계수 정렬 방식이라 삽입 순서가 인덱스 순서로
 * 고정되고, 따라서 질의 결과 순서도 항상 같다 — 결정론이 깨지지 않는다.
 */
export class SpatialHash {
  private readonly cellSize: number
  private readonly invCell: number
  private readonly gridW: number
  private readonly gridH: number
  private readonly originX: number
  private readonly originY: number

  /** 셀별 시작 오프셋(prefix sum). 길이 = cellCount + 1 */
  private readonly cellStart: Int32Array
  /** 계수 정렬 임시 버퍼 */
  private readonly cellCount: Int32Array
  /** 셀 순으로 정렬된 아이템 인덱스 */
  private readonly items: Int32Array
  /** 각 아이템의 셀 번호 */
  private readonly itemCell: Int32Array

  private itemN = 0

  /**
   * @param halfExtent 원점 기준 반경(월드 단위). 아레나 반지름보다 넉넉히.
   * @param cellSize   셀 한 변. 가장 흔한 질의 반경과 비슷하게 잡는 게 좋다.
   * @param capacity   담을 수 있는 최대 아이템 수.
   */
  constructor(halfExtent: number, cellSize: number, capacity: number) {
    this.cellSize = cellSize
    this.invCell = 1 / cellSize
    this.originX = -halfExtent
    this.originY = -halfExtent
    this.gridW = Math.ceil((halfExtent * 2) / cellSize) + 1
    this.gridH = this.gridW

    const cells = this.gridW * this.gridH
    this.cellStart = new Int32Array(cells + 1)
    this.cellCount = new Int32Array(cells)
    this.items = new Int32Array(capacity)
    this.itemCell = new Int32Array(capacity)
  }

  private cellIndex(x: number, y: number): number {
    let cx = Math.floor((x - this.originX) * this.invCell)
    let cy = Math.floor((y - this.originY) * this.invCell)
    // 범위를 벗어난 좌표는 가장자리 셀로 접는다. 아레나 밖은 없어야 정상이지만
    // 넉백으로 잠깐 튀어나갈 수 있어 방어한다.
    if (cx < 0) cx = 0
    else if (cx >= this.gridW) cx = this.gridW - 1
    if (cy < 0) cy = 0
    else if (cy >= this.gridH) cy = this.gridH - 1
    return cy * this.gridW + cx
  }

  /**
   * 격자를 처음부터 다시 만든다.
   * @param n     아이템 수
   * @param xs    x좌표 배열
   * @param ys    y좌표 배열
   */
  rebuild(n: number, xs: Float32Array, ys: Float32Array): void {
    this.itemN = Math.min(n, this.items.length)
    this.cellCount.fill(0)

    for (let i = 0; i < this.itemN; i++) {
      const c = this.cellIndex(xs[i]!, ys[i]!)
      this.itemCell[i] = c
      this.cellCount[c]!++
    }

    // prefix sum
    let acc = 0
    for (let c = 0; c < this.cellCount.length; c++) {
      this.cellStart[c] = acc
      acc += this.cellCount[c]!
    }
    this.cellStart[this.cellCount.length] = acc

    // 커서를 재사용해 배치. cellCount를 쓰기 커서로 재활용한다.
    this.cellCount.fill(0)
    for (let i = 0; i < this.itemN; i++) {
      const c = this.itemCell[i]!
      this.items[this.cellStart[c]! + this.cellCount[c]!] = i
      this.cellCount[c]!++
    }
  }

  /**
   * (x, y) 반경 radius 안에 있을 "가능성이 있는" 아이템 인덱스를 out에 채운다.
   * 격자 단위라 넓게 잡히므로 호출부에서 실제 거리를 다시 재야 한다.
   * @returns 채운 개수
   */
  query(x: number, y: number, radius: number, out: Int32Array): number {
    const minX = Math.max(0, Math.floor((x - radius - this.originX) * this.invCell))
    const maxX = Math.min(this.gridW - 1, Math.floor((x + radius - this.originX) * this.invCell))
    const minY = Math.max(0, Math.floor((y - radius - this.originY) * this.invCell))
    const maxY = Math.min(this.gridH - 1, Math.floor((y + radius - this.originY) * this.invCell))

    let n = 0
    const cap = out.length
    for (let cy = minY; cy <= maxY; cy++) {
      const row = cy * this.gridW
      for (let cx = minX; cx <= maxX; cx++) {
        const c = row + cx
        const start = this.cellStart[c]!
        const end = this.cellStart[c + 1]!
        for (let k = start; k < end; k++) {
          if (n >= cap) return n
          out[n++] = this.items[k]!
        }
      }
    }
    return n
  }

  get cellExtent(): number {
    return this.cellSize
  }
}
