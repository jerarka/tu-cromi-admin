<script setup lang="ts">
import { MousePointer2, Plus, Route, Trash2 } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from '@/components/ui/tooltip';
import type { EditMode } from '@/composables/useRouteGeometry';

const props = defineProps<{
    modelValue: EditMode;
}>();

const emit = defineEmits<{
    (e: 'update:modelValue', value: EditMode): void;
}>();

/**
 * The four editing modes, as data rather than as markup.
 *
 * Declared here so that adding a mode is one entry in one file. It was
 * twenty-six duplicated lines in each of the two pages that use it, and the two
 * copies were free to drift — which is the only interesting property of
 * duplicated markup, and the one that eventually costs.
 *
 * The icon is not a substitute for the label, it is the same label drawn. The
 * tooltip and the screen-reader text both repeat `label` verbatim rather than
 * describing the glyph, which is the whole reason this table can be rendered
 * icon-only: the words were moved, not deleted, and there is exactly one copy
 * of them to keep in sync.
 *
 * `key` is the number that switches to this mode, and it is here rather than
 * written into the template because a shortcut this codebase invented has to be
 * discoverable somewhere the reviewer already looks — and a key pressed by
 * muscle memory from a help panel is not the same as one printed on the button
 * that does the thing. It travels into the tooltip, and into the screen-reader
 * text, because the icon carries neither.
 */
const modes: {
    value: EditMode;
    label: string;
    key: string;
    icon: typeof MousePointer2;
}[] = [
    { value: 'move', label: 'Move', key: '1', icon: MousePointer2 },
    {
        value: 'guide',
        label: 'Guide along streets',
        key: '2',
        icon: Route,
    },
    { value: 'add', label: 'Add vertex', key: '3', icon: Plus },
    { value: 'delete', label: 'Delete vertex', key: '4', icon: Trash2 },
];
</script>

<template>
    <div class="flex flex-wrap items-center gap-3">
        <!--
            A name for the group, invisible on screen. The settings beside it
            have visible labels, so the three mode buttons were the only
            controls in the editor with nothing naming what the group is — which
            is the kind of gap that makes a segmented control unusable with a
            screen reader, since "Move, Add vertex, Delete vertex" is three
            buttons and no indication that they are alternatives to each other.

            Each button carries its own label as sr-only text as well, and that
            is not redundant with the group name: the group says what the three
            have in common, the per-button text says what this one does.
        -->
        <div
            class="flex flex-wrap gap-2"
            role="group"
            aria-label="Editing mode"
        >
            <!--
                One provider for the three rather than one each. The delay is
                identical for all of them and Radix context is not free; the
                wrapper is here rather than outside the flex row because
                Provider renders no element of its own, so a class on it would
                silently do nothing.
            -->
            <TooltipProvider :delay-duration="0">
                <Tooltip v-for="option in modes" :key="option.value">
                    <TooltipTrigger as-child>
                        <Button
                            type="button"
                            :variant="
                                props.modelValue === option.value
                                    ? 'default'
                                    : 'outline'
                            "
                            size="icon-sm"
                            :aria-pressed="props.modelValue === option.value"
                            @click="emit('update:modelValue', option.value)"
                        >
                            <component :is="option.icon" class="size-4" />
                            <span class="sr-only">
                                {{ option.label }} ({{ option.key }})
                            </span>
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent class="max-w-xs">
                        <p>{{ option.label }} ({{ option.key }})</p>
                    </TooltipContent>
                </Tooltip>
            </TooltipProvider>
        </div>

        <!--
            Its own group rather than more buttons in the same row, because the
            slot holds settings and the buttons are modes: "what a click does"
            against "how much". Flattened into one row the two read as a single
            list, and the reviewer cannot tell which control changes the gesture
            and which only calibrates it.

            Bordered and muted rather than split with a vertical rule, because this
            row wraps on a narrow column and a divider that ends up leading a
            wrapped line looks like a mistake.

            The `min-h-9` on the inner wrapper is what keeps the map still. This
            box is height-bearing — padding and a border around a full-height
            control — so when the slot's own `v-if` took the settings away with
            it, the box collapsed and everything below it, the map included, moved
            under the reviewer mid-gesture. The rule this page already follows is
            that showing and hiding may only ever change WIDTH; a box that shrinks
            breaks it, and the way to keep the rule is to hold the height rather
            than to hold the controls.

            `min-h-9` and not a pixel figure: the tallest thing in here is the
            snap Select's own trigger, which is `h-9`, and reading the two off the
            same scale means the reservation follows the control if its size is
            ever changed, instead of quietly being 14 pixels too short one day.
        -->
        <div
            v-if="$slots.default"
            class="flex flex-wrap items-center gap-4 rounded-md border border-dashed bg-muted/40 px-3 py-1.5"
        >
            <div class="flex min-h-9 flex-wrap items-center gap-4">
                <slot />
            </div>
        </div>
    </div>
</template>
