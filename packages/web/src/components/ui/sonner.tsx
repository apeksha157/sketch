import { CheckCircleIcon, InfoIcon, SpinnerGapIcon, WarningCircleIcon, WarningIcon } from "@phosphor-icons/react";
import { Toaster as Sonner, type ToasterProps } from "sonner";

const statusIconClass = "size-[18px] shrink-0";

/**
 * App-branded wrapper around sonner's Toaster. The card stays neutral (frosted
 * popover surface, like the chat switcher) and status is carried by a single
 * coloured icon rather than a loud full-bleed tint — matching the builder's
 * "status by colour, quiet" law.
 */
function Toaster(props: ToasterProps) {
  return (
    <Sonner
      position="bottom-right"
      gap={10}
      offset={16}
      className="toaster group"
      icons={{
        success: <CheckCircleIcon weight="fill" className={`${statusIconClass} text-emerald-500`} />,
        error: <WarningCircleIcon weight="fill" className={`${statusIconClass} text-destructive`} />,
        warning: <WarningIcon weight="fill" className={`${statusIconClass} text-amber-500`} />,
        info: <InfoIcon weight="fill" className={`${statusIconClass} text-muted-foreground`} />,
        loading: <SpinnerGapIcon className={`${statusIconClass} animate-spin text-muted-foreground`} />,
      }}
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:items-center group-[.toaster]:!gap-2.5 group-[.toaster]:!rounded-[12px] group-[.toaster]:!border group-[.toaster]:!border-border/70 group-[.toaster]:!bg-popover/95 group-[.toaster]:!px-3.5 group-[.toaster]:!py-3 group-[.toaster]:!text-popover-foreground group-[.toaster]:!shadow-lg group-[.toaster]:backdrop-blur",
          content: "group-[.toast]:gap-0.5",
          title:
            "group-[.toast]:text-[13px] group-[.toast]:font-medium group-[.toast]:leading-5 group-[.toast]:text-foreground",
          description: "group-[.toast]:text-[12px] group-[.toast]:leading-5 group-[.toast]:text-muted-foreground",
          icon: "group-[.toast]:m-0",
          actionButton:
            "group-[.toast]:rounded-[7px] group-[.toast]:bg-foreground group-[.toast]:px-2.5 group-[.toast]:py-1 group-[.toast]:text-[12px] group-[.toast]:font-medium group-[.toast]:text-background",
          cancelButton:
            "group-[.toast]:rounded-[7px] group-[.toast]:bg-muted group-[.toast]:px-2.5 group-[.toast]:py-1 group-[.toast]:text-[12px] group-[.toast]:font-medium group-[.toast]:text-muted-foreground",
          closeButton:
            "group-[.toast]:rounded-full group-[.toast]:border-border/70 group-[.toast]:bg-popover group-[.toast]:text-muted-foreground hover:group-[.toast]:!text-foreground",
        },
      }}
      {...props}
    />
  );
}

export { Toaster };
