import assert from 'node:assert/strict'

import { ChoiceInputGate } from './choice-input-gate.ts'

{
  const gate = new ChoiceInputGate({
    heldCodes: ['KeyQ', 'KeyR'],
    pointerDown: true,
  })

  assert.equal(gate.allowsKeyDown('KeyQ'), false)
  assert.equal(gate.allowsKeyDown('KeyR'), false)
  assert.equal(gate.allowsKeyDown('Digit1'), true)
  gate.releaseKey('KeyQ')
  assert.equal(gate.allowsKeyDown('KeyQ'), true)

  assert.equal(gate.beginPointerPress(), false)
  gate.releasePointer()
  assert.equal(gate.allowsClick(1), false)
  assert.equal(gate.beginPointerPress(), true)
  assert.equal(gate.allowsClick(1), true)
}

{
  const gate = new ChoiceInputGate()
  assert.equal(gate.beginPointerPress(), true)
  assert.equal(gate.allowsClick(1), true)
  assert.equal(gate.allowsClick(0), true)
}

console.log('choice-input-gate: stale holds blocked and fresh choices accepted')
