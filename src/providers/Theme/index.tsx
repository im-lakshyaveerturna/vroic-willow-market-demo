'use client'

import React, { createContext, useCallback, useContext, useEffect, useSyncExternalStore } from 'react'
import type { Theme, ThemeContextType } from './types'
import { defaultTheme, themeLocalStorageKey } from './shared'
import { getThemeSnapshot, notifyThemeChanged, subscribeTheme } from './store'

const ThemeContext = createContext<ThemeContextType>({ setTheme: () => null, theme: undefined })

export const ThemeProvider = ({ children }: { children: React.ReactNode }) => {
  const theme = useSyncExternalStore(subscribeTheme, getThemeSnapshot, () => defaultTheme)
  const setTheme = useCallback((value: Theme | null) => {
    if (value === null) window.localStorage.removeItem(themeLocalStorageKey)
    else window.localStorage.setItem(themeLocalStorageKey, value)
    document.documentElement.setAttribute('data-theme', getThemeSnapshot())
    notifyThemeChanged()
  }, [])
  useEffect(() => { document.documentElement.setAttribute('data-theme', theme) }, [theme])
  return <ThemeContext.Provider value={{ setTheme, theme }}>{children}</ThemeContext.Provider>
}

export const useTheme = (): ThemeContextType => useContext(ThemeContext)
