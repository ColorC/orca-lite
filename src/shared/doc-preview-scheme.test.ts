import { describe, expect, it } from 'vitest'
import {
  buildDocPreviewUrl,
  parseDocPreviewToolTargetId,
  parseDocPreviewUrl,
  toDocPreviewToolTargetId
} from './doc-preview-scheme'

const GRANT = 'a'.repeat(32)

describe('doc preview URLs', () => {
  it('round-trips a nested relative path', () => {
    const url = buildDocPreviewUrl(GRANT, 'assets/logo.png')

    expect(url).toBe(`orca-preview://${GRANT}/assets/logo.png`)
    expect(parseDocPreviewUrl(url)).toEqual({ grantId: GRANT, relativePath: 'assets/logo.png' })
  })

  it('encodes characters that would otherwise split the URL', () => {
    const url = buildDocPreviewUrl(GRANT, 'a b/c#d?e.html')

    expect(url).toBe(`orca-preview://${GRANT}/a%20b/c%23d%3Fe.html`)
    expect(parseDocPreviewUrl(url)).toEqual({ grantId: GRANT, relativePath: 'a b/c#d?e.html' })
  })

  it('normalizes backslashes into path segments so a Windows path cannot smuggle one segment', () => {
    expect(parseDocPreviewUrl(buildDocPreviewUrl(GRANT, 'assets\\logo.png'))).toEqual({
      grantId: GRANT,
      relativePath: 'assets/logo.png'
    })
  })

  it('reports an empty relative path for a root request', () => {
    expect(parseDocPreviewUrl(`orca-preview://${GRANT}/`)).toEqual({
      grantId: GRANT,
      relativePath: ''
    })
  })

  it('rejects malformed grant ids and other schemes', () => {
    expect(parseDocPreviewUrl('orca-preview://SHORT/index.html')).toBeNull()
    expect(parseDocPreviewUrl(`orca-preview://${'g'.repeat(32)}/index.html`)).toBeNull()
    expect(parseDocPreviewUrl(`https://${GRANT}/index.html`)).toBeNull()
    expect(parseDocPreviewUrl('not a url')).toBeNull()
  })

  it('rejects an undecodable percent sequence rather than passing raw bytes through', () => {
    expect(parseDocPreviewUrl(`orca-preview://${GRANT}/%E0%A4%A.html`)).toBeNull()
  })
})

describe('preview tool target ids', () => {
  it('round-trips a grant id', () => {
    expect(parseDocPreviewToolTargetId(toDocPreviewToolTargetId(GRANT))).toBe(GRANT)
  })

  // Why the suffix must be validated and not just the prefix: main dispatches tool requests on this
  // namespace, so anything it accepts here is a string a renderer can aim at the preview authority.
  it('rejects a prefixed id whose suffix is not a grant id', () => {
    expect(parseDocPreviewToolTargetId('doc-preview-grant:')).toBeNull()
    expect(parseDocPreviewToolTargetId('doc-preview-grant:page-1')).toBeNull()
    expect(parseDocPreviewToolTargetId(`doc-preview-grant:${'g'.repeat(32)}`)).toBeNull()
    expect(parseDocPreviewToolTargetId(`doc-preview-grant:${GRANT}extra`)).toBeNull()
    expect(parseDocPreviewToolTargetId(`doc-preview-grant:${GRANT.toUpperCase()}`)).toBeNull()
  })

  it('rejects an id that is not in the namespace at all', () => {
    expect(parseDocPreviewToolTargetId(GRANT)).toBeNull()
    expect(parseDocPreviewToolTargetId(`page:${GRANT}`)).toBeNull()
    expect(parseDocPreviewToolTargetId('')).toBeNull()
  })
})
