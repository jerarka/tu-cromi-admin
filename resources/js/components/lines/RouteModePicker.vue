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
    <div class="flex flex-wrap gap-2">
        <Button
            v-for="option in modes"
            :key="option.value"
            type="button"
            :variant="props.modelValue === option.value ? 'default' : 'outline'"
            size="sm"
            @click="emit('update:modelValue', option.value)"
        >
            {{ option.label }}
        </Button>

        <!--
            Anything a caller wants beside the modes, in the same row. The edit
            page keeps the snap preset here, and it belongs in this row rather
            than below it: it only applies to one mode, and the reviewer reads
            it as a property of moving rather than as a separate control.
        -->
        <slot />
    </div>
</template>
