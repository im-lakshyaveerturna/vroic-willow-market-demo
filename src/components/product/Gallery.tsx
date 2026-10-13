'use client'

import type { Media as MediaType, Product } from '@/payload-types'

import { Media } from '@/components/Media'
import { GridTileImage } from '@/components/Grid/tile'
import { useSearchParams } from 'next/navigation'
import React, { useEffect } from 'react'

import { Carousel, CarouselApi, CarouselContent, CarouselItem } from '@/components/ui/carousel'

type Props = {
  gallery: NonNullable<Product['gallery']>
}

export const Gallery: React.FC<Props> = ({ gallery }) => {
  const searchParams = useSearchParams()
  const [current, setCurrent] = React.useState(() => {
    const selected = gallery.findIndex(item => item.variantOption && Array.from(searchParams.values()).includes(String(typeof item.variantOption === 'object' ? item.variantOption.id : item.variantOption)))
    return selected === -1 ? 0 : selected
  })
  const query = searchParams.toString()
  const [previousQuery, setPreviousQuery] = React.useState(query)
  if (previousQuery !== query) {
    setPreviousQuery(query)
    const selected = gallery.findIndex(item => item.variantOption && Array.from(searchParams.values()).includes(String(typeof item.variantOption === 'object' ? item.variantOption.id : item.variantOption)))
    if (selected !== -1) setCurrent(selected)
  }
  const [api, setApi] = React.useState<CarouselApi>()

  useEffect(() => { api?.scrollTo(current, true) }, [api, current])

  if (!gallery.length) return null

  return (
    <div>
      <div className="relative w-full overflow-hidden mb-8">
        <Media
          resource={gallery[current].image}
          className="w-full"
          imgClassName="w-full rounded-lg"
        />
      </div>

      <Carousel setApi={setApi} className="w-full" opts={{ align: 'start', loop: false }}>
        <CarouselContent>
          {gallery.map((item, i) => {
            if (typeof item.image !== 'object') return null

            return (
              <CarouselItem
                className="basis-1/5"
                key={`${item.image.id}-${i}`}
                onClick={() => setCurrent(i)}
              >
                <GridTileImage active={i === current} media={item.image} />
              </CarouselItem>
            )
          })}
        </CarouselContent>
      </Carousel>
    </div>
  )
}
