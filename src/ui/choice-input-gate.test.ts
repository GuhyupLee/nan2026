import assert from 'node:assert/strict'

import {
  CHOICE_POINTER_GRACE_MS,
  CHOICE_POINTER_MOVE_ARM_DISTANCE,
  ChoiceInputGate,
} from './choice-input-gate.ts'

{
  const gate = new ChoiceInputGate(
    {
      heldCodes: ['KeyQ', 'KeyR'],
      pointerDown: true,
      pointerX: 400,
      pointerY: 300,
    },
    1_000,
  )

  assert.equal(gate.allowsKeyDown('KeyQ'), false)
  assert.equal(gate.allowsKeyDown('KeyR'), false)
  assert.equal(gate.allowsKeyDown('Digit1'), true)
  gate.releaseKey('KeyQ')
  assert.equal(gate.allowsKeyDown('KeyQ'), true)

  assert.equal(gate.beginPointerPress(1_050), false)
  gate.releasePointer()
  assert.equal(gate.allowsClick(1), false)
  assert.equal(
    gate.beginPointerPress(1_000 + CHOICE_POINTER_GRACE_MS - 1),
    false,
  )
  assert.equal(gate.allowsClick(1), false)
  assert.equal(
    gate.beginPointerPress(1_000 + CHOICE_POINTER_GRACE_MS),
    true,
  )
  assert.equal(gate.allowsClick(1), true)
}

{
  const gate = new ChoiceInputGate(
    {
      heldCodes: [],
      pointerDown: false,
      pointerX: 400,
      pointerY: 300,
    },
    2_000,
  )

  assert.equal(gate.beginPointerPress(2_050), false)
  gate.notePointerMove(
    400 + CHOICE_POINTER_MOVE_ARM_DISTANCE,
    300,
  )
  assert.equal(gate.beginPointerPress(2_051), true)
  assert.equal(gate.allowsClick(1), true)
  assert.equal(gate.allowsClick(0), true)
}

{
  const gate = new ChoiceInputGate(undefined, 3_000)
  assert.equal(gate.allowsKeyDown('Digit1'), true)
  assert.equal(gate.beginPointerPress(3_000 + CHOICE_POINTER_GRACE_MS), true)
}

console.log(
  'choice-input-gate: held and rapid pointer input blocked; deliberate choices accepted',
)
