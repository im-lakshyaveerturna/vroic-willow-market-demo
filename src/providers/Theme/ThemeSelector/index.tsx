'use client'

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import React, { useSyncExternalStore } from 'react'


import { useTheme } from '..'
import { getThemePreference, subscribeTheme } from '../store'

export const ThemeSelector: React.FC = () => {
  const { setTheme } = useTheme()
  const value = useSyncExternalStore(subscribeTheme, getThemePreference, () => 'auto')

  const onThemeChange = (themeToSet: string) => {
    if (themeToSet === 'auto') {
      setTheme(null)
    } else if (themeToSet === 'light' || themeToSet === 'dark') {
      setTheme(themeToSet)
    }
  }


  return (
    <Select onValueChange={onThemeChange} value={value}>
      <SelectTrigger className="w-auto bg-transparent gap-2 md:pl-3 border-none">
        <SelectValue placeholder="Theme" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="auto">Auto</SelectItem>
        <SelectItem value="light">Light</SelectItem>
        <SelectItem value="dark">Dark</SelectItem>
      </SelectContent>
    </Select>
  )
}
