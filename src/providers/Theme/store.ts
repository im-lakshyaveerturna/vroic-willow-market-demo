import { defaultTheme, getImplicitPreference, themeLocalStorageKey } from './shared'
import { themeIsValid } from './types'

const changedEvent = 'willow-theme-change'
export const getThemePreference = () => window.localStorage.getItem(themeLocalStorageKey) || 'auto'
export const getThemeSnapshot = () => {
  const preference = getThemePreference()
  return themeIsValid(preference) ? preference : getImplicitPreference() || defaultTheme
}
export function subscribeTheme(changed: () => void) {
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  window.addEventListener('storage', changed)
  window.addEventListener(changedEvent, changed)
  media.addEventListener('change', changed)
  return () => {
    window.removeEventListener('storage', changed)
    window.removeEventListener(changedEvent, changed)
    media.removeEventListener('change', changed)
  }
}
export function notifyThemeChanged() { window.dispatchEvent(new Event(changedEvent)) }
