<script setup lang="ts">
import { Button } from '@/components/ui/button';
import type { EditMode } from '@/composables/useRouteGeometry';

const props = defineProps<{
    modelValue: EditMode;
}>();

const emit = defineEmits<{
    (e: 'update:modelValue', value: EditMode): void;
}>();

/**
 * The three editing modes, as data rather than as markup.
 *
 * Declared here so that adding a mode is one entry in one file. It was
 * twenty-six duplicated lines in each of the two pages that use it, and the two
 * copies were free to drift — which is the only interesting property of
 * duplicated markup, and the one that eventually costs.
 */
const modes: { value: EditMode; label: string }[] = [
    { value: 'move', label: 'Move' },
    { value: 'add', label: 'Add vertex' },
    { value: 'delete', label: 'Delete vertex' },
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
        -->
        <div
            class="flex flex-wrap gap-2"
            role="group"
            aria-label="Editing mode"
        >
            <Button
                v-for="option in modes"
                :key="option.value"
                type="button"
                :variant="
                    props.modelValue === option.value ? 'default' : 'outline'
                "
                size="sm"
                @click="emit('update:modelValue', option.value)"
            >
                {{ option.label }}
            </Button>
        </div>

        <!--
            Its own group rather than more buttons in the same row, because the
            slot holds settings and the buttons are modes: "what a click does"
            against "how much". Flattened into one row the two read as a single
            list, and the reviewer cannot tell which control changes the gesture
            and which only calibrates it.

            Bordered and muted rather than split with a vertical rule, because
            this row wraps on a narrow column and a divider that ends up leading
            a wrapped line looks like a mistake.
        -->
        <div
            v-if="$slots.default"
            class="flex flex-wrap items-center gap-4 rounded-md border border-dashed bg-muted/40 px-3 py-1.5"
        >
            <slot />
        </div>
    </div>
</template>
