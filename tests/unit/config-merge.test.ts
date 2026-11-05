/**
 * Unit tests for the field-level three-way config merge.
 */

import { describe, expect, it } from 'vitest'
import { mergeConfigs } from '../../src/services/config-merge.js'

describe('mergeConfigs', () => {
  it('merges keys changed on different devices', () => {
    const result = mergeConfigs(
      { timeout: 10, retries: 2 },
      { timeout: 20, retries: 2 },
      { timeout: 10, retries: 3 },
    )
    expect(result.conflicts).toEqual([])
    expect(result.merged).toEqual({ timeout: 20, retries: 3 })
    expect(result.localKeys).toEqual(['timeout'])
    expect(result.remoteKeys).toEqual(['retries'])
  })

  it('keeps a key both devices changed to the same value', () => {
    const result = mergeConfigs({ timeout: 10 }, { timeout: 20 }, { timeout: 20 })
    expect(result.conflicts).toEqual([])
    expect(result.merged).toEqual({ timeout: 20 })
  })

  it('reports a key both devices changed differently', () => {
    const result = mergeConfigs({ timeout: 10 }, { timeout: 20 }, { timeout: 30 })
    expect(result.conflicts).toEqual(['timeout'])
    expect(result.merged).toEqual({})
  })

  it('takes an added key from the side that changed it', () => {
    const result = mergeConfigs({}, { timeout: 20 }, { retries: 3 })
    expect(result.conflicts).toEqual([])
    expect(result.merged).toEqual({ retries: 3, timeout: 20 })
  })

  it('treats a deletion as a change and merges it with another key', () => {
    const result = mergeConfigs({ timeout: 10, retries: 2 }, { retries: 2 }, { timeout: 10, retries: 5 })
    expect(result.conflicts).toEqual([])
    expect(result.merged).toEqual({ retries: 5 })
  })

  it('reports deletion against modification as a conflict', () => {
    const result = mergeConfigs({ timeout: 10 }, {}, { timeout: 20 })
    expect(result.conflicts).toEqual(['timeout'])
  })

  it('distinguishes a missing key from an explicit null', () => {
    const result = mergeConfigs({ value: 1 }, { value: null }, { value: 1 })
    expect(result.conflicts).toEqual([])
    expect(result.merged).toEqual({ value: null })
  })

  it('supports a missing baseline (first sync)', () => {
    const result = mergeConfigs(undefined, { timeout: 20 }, { retries: 3 })
    expect(result.conflicts).toEqual([])
    expect(result.merged).toEqual({ retries: 3, timeout: 20 })
  })
})
