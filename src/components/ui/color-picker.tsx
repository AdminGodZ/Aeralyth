"use client"

import type { PopoverContentProps } from "@radix-ui/react-popover"
import {
  type HexColor,
  hexToHsva,
  type HslaColor,
  hslaToHsva,
  type HsvaColor,
  hsvaToHex,
  hsvaToHsla,
  hsvaToRgba,
  type RgbaColor,
  rgbaToHsva,
} from "@uiw/color-convert"
import Hue from "@uiw/react-color-hue"
import Saturation from "@uiw/react-color-saturation"
import { ChevronDownIcon } from "lucide-react"
import React from "react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"

function getColorAsHsva(
  color: `#${string}` | HsvaColor | HslaColor | RgbaColor
): HsvaColor {
  if (typeof color === "string") {
    return hexToHsva(color)
  }

  if ("h" in color && "s" in color && "v" in color) {
    return color
  }

  if ("r" in color) {
    return rgbaToHsva(color)
  }

  return hslaToHsva(color)
}

type ColorPickerValue = {
  hex: string
  hsl: HslaColor
  rgb: RgbaColor
}

type ColorPickerProps = {
  value?: `#${string}` | HsvaColor | HslaColor | RgbaColor
  type?: "hsl" | "rgb" | "hex"
  swatches?: HexColor[]
  hideDefaultSwatches?: boolean
  className?: string
  onValueChange?: (value: ColorPickerValue) => void
} & PopoverContentProps

function ColorPicker({
  value,
  children,
  type = "hsl",
  swatches = [],
  hideDefaultSwatches,
  onValueChange,
  className,
  ...props
}: ColorPickerProps) {
  const [colorType, setColorType] = React.useState(type)
  const [colorHsv, setColorHsv] = React.useState<HsvaColor>(
    value ? getColorAsHsva(value) : { h: 0, s: 0, v: 0, a: 1 }
  )
  const colorSwatches = hideDefaultSwatches
    ? swatches
    : [
        "#F8371A",
        "#F97C1B",
        "#FAC81C",
        "#3FD0B6",
        "#2CADF6",
        "#6462FC",
        ...swatches,
      ]
  const hueThumbColor = `hsl(${Math.round(colorHsv.h)} 100% 50%)`

  React.useEffect(() => {
    if (value) {
      setColorHsv(getColorAsHsva(value))
    }
  }, [value])

  const handleValueChange = (color: HsvaColor) => {
    onValueChange?.({
      hex: hsvaToHex(color),
      hsl: hsvaToHsla(color),
      rgb: hsvaToRgba(color),
    })

    setColorHsv(color)
  }

  return (
    <Popover>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        className={cn("w-[350px] p-0", className)}
        {...props}
        style={
          {
            ...props.style,
          } as React.CSSProperties
        }
      >
        <div className="space-y-4 p-4">
          <Saturation
            hsva={colorHsv}
            onChange={(newColor) => {
              handleValueChange(newColor)
            }}
            radius="0.3rem"
            pointer={SaturationPointer}
            style={{
              width: "100%",
              height: "auto",
              aspectRatio: "4/2",
              borderRadius: "0.3rem",
              boxShadow: "inset 0 0 0 1px var(--border)",
              overflow: "hidden",
            }}
            className="focus-visible:outline-none"
          />
          <Hue
            hue={colorHsv.h}
            onChange={(newHue) => {
              handleValueChange({ ...colorHsv, ...newHue })
            }}
            className="[&>div:first-child]:overflow-hidden [&>div:first-child]:!rounded"
            style={
              {
                width: "100%",
                height: "0.9rem",
                borderRadius: "0.3rem",
                "--alpha-pointer-background-color": hueThumbColor,
                "--alpha-pointer-box-shadow":
                  "0 0 0 2px var(--popover), 0 0 0 3px color-mix(in oklch, var(--foreground) 35%, transparent), 0 2px 7px rgb(0 0 0 / 35%)",
              } as React.CSSProperties
            }
          />

          <div className="flex items-center gap-3">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  className="shrink-0 justify-between uppercase"
                >
                  {colorType}
                  <ChevronDownIcon
                    className="-me-1 ms-2 opacity-60"
                    size={16}
                    strokeWidth={2}
                    aria-hidden="true"
                  />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuCheckboxItem
                  checked={colorType === "hex"}
                  onCheckedChange={() => setColorType("hex")}
                >
                  HEX
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  checked={colorType === "hsl"}
                  onCheckedChange={() => setColorType("hsl")}
                >
                  HSL
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  checked={colorType === "rgb"}
                  onCheckedChange={() => setColorType("rgb")}
                >
                  RGB
                </DropdownMenuCheckboxItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <div className="flex grow">
              {colorType === "hsl" && (
                <ObjectColorInput
                  value={hsvaToHsla(colorHsv)}
                  label="hsl"
                  onValueChange={(value) => {
                    handleValueChange(hslaToHsva(value))
                  }}
                />
              )}
              {colorType === "rgb" && (
                <ObjectColorInput
                  value={hsvaToRgba(colorHsv)}
                  label="rgb"
                  onValueChange={(value) => {
                    handleValueChange(rgbaToHsva(value))
                  }}
                />
              )}
              {colorType === "hex" && (
                <Input
                  className="flex focus-visible:border-transparent focus-visible:ring-0"
                  value={hsvaToHex(colorHsv)}
                  onChange={(event) => {
                    const nextValue = event.target.value

                    if (/^#[0-9a-f]{6}$/i.test(nextValue)) {
                      handleValueChange(hexToHsva(nextValue))
                    }
                  }}
                />
              )}
            </div>
          </div>
          {colorSwatches.length > 0 ? <Separator /> : null}
          {colorSwatches.length > 0 ? (
            <div className="-m-1 flex flex-nowrap justify-start gap-3 overflow-visible p-1">
              {colorSwatches
                .sort((a, b) => hexToHsva(a).h - hexToHsva(b).h)
                .map((color) => (
                  <button
                    type="button"
                    key={`${color}-swatch`}
                    style={
                      {
                        "--swatch-color": color,
                      } as React.CSSProperties
                    }
                    onClick={() => handleValueChange(hexToHsva(color))}
                    aria-label={`Set color to ${color}`}
                    className="size-5 cursor-pointer rounded bg-[var(--swatch-color)] ring-2 ring-[var(--swatch-color)00] ring-offset-1 ring-offset-background transition-all duration-100 hover:ring-[var(--swatch-color)]"
                  />
                ))}
            </div>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}

type ObjectColorInputProps =
  | {
      label: "hsl"
      value: HslaColor
      onValueChange?: (value: HslaColor) => void
    }
  | {
      label: "rgb"
      value: RgbaColor
      onValueChange?: (value: RgbaColor) => void
    }

function ObjectColorInput({
  value,
  label,
  onValueChange,
}: ObjectColorInputProps) {
  const inputClassName =
    "h-full rounded-none border-0 bg-transparent shadow-none [direction:inherit] focus-visible:border-transparent focus-visible:ring-0"

  function handleChange(val: Partial<HslaColor | RgbaColor>) {
    if (onValueChange) {
      onValueChange({
        ...value,
        ...val,
      } as HslaColor & RgbaColor)
    }
  }

  return (
    <div className="flex h-8 overflow-hidden rounded-2xl bg-input/50">
      <div className="relative min-w-0 flex-1 border-r border-border/50">
        <Input
          className={inputClassName}
          value={label === "hsl" ? value.h.toFixed(0) : value.r}
          onChange={(event) =>
            handleChange({
              [label === "hsl" ? "h" : "r"]: getNumericColorValue(
                event.target.value
              ),
            })
          }
        />
      </div>
      <div className="relative min-w-0 flex-1 border-r border-border/50">
        <Input
          className={inputClassName}
          value={label === "hsl" ? value.s.toFixed(0) : value.g}
          onChange={(event) =>
            handleChange({
              [label === "hsl" ? "s" : "g"]: getNumericColorValue(
                event.target.value
              ),
            })
          }
        />
      </div>
      <div className="relative min-w-0 flex-1">
        <Input
          className={inputClassName}
          value={label === "hsl" ? value.l.toFixed(0) : value.b}
          onChange={(event) =>
            handleChange({
              [label === "hsl" ? "l" : "b"]: getNumericColorValue(
                event.target.value
              ),
            })
          }
        />
      </div>
    </div>
  )
}

type SaturationPointerProps = {
  prefixCls?: string
  left?: string | number
  top?: string | number
  color?: string
}

function SaturationPointer({
  prefixCls,
  left,
  top,
  color,
}: SaturationPointerProps) {
  const offsetLeft = getClampedPointerOffset(left ?? "0%")
  const offsetTop = getClampedPointerOffset(top ?? "0%")

  return (
    <div
      className={`${prefixCls ?? "w-color-saturation"}-pointer`}
      style={{
        position: "absolute",
        left: offsetLeft,
        top: offsetTop,
      }}
    >
      <div
        className={`${prefixCls ?? "w-color-saturation"}-fill`}
        style={{
          width: 8,
          height: 8,
          transform: "translate(-4px, -4px)",
          border: "2px solid white",
          borderRadius: "50%",
          backgroundColor: color,
          boxShadow:
            "0 0 0 1px rgb(0 0 0 / 50%), 0 1px 3px rgb(0 0 0 / 35%)",
        }}
      />
    </div>
  )
}

function getClampedPointerOffset(value: string | number) {
  const offset = typeof value === "number" ? `${value}px` : value

  return `clamp(6px, ${offset}, calc(100% - 6px))`
}

function getNumericColorValue(value: string) {
  const nextValue = Number.parseFloat(value)

  if (!Number.isFinite(nextValue)) {
    return 0
  }

  return nextValue
}

export { ColorPicker }
export type { ColorPickerProps, ColorPickerValue }
