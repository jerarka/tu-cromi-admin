<script setup lang="ts">
import { Form, Head, router } from '@inertiajs/vue3';
import {
    ArrowLeft,
    ArrowLeftRight,
    ArrowRightLeft,
    ChevronLeft,
    ChevronRight,
    RotateCcw,
    Shuffle,
} from '@lucide/vue';
import { computed, ref, watch } from 'vue';
import LineController from '@/actions/App/Http/Controllers/Admin/LineController';
import Heading from '@/components/Heading.vue';
import InputError from '@/components/InputError.vue';
import LineMap from '@/components/lines/LineMap.vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import lines from '@/routes/lines';
import type { DirectionOperation, Line, LineNav } from '@/types/line';

const props = defineProps<{
    line: Line;
    counterpart?: Pick<Line, 'id' | 'code' | 'sense'> | null;
    nav: LineNav;
}>();

const geoJsonText = ref(
    props.line.geo_json ? JSON.stringify(props.line.geo_json, null, 2) : '',
);

const parsedGeoJson = computed(() => {
    if (!geoJsonText.value) {
        return null;
    }

    try {
        return JSON.parse(geoJsonText.value) as NonNullable<Line['geo_json']>;
    } catch {
        return null;
    }
});

const isEditingMap = ref(false);
const mode = ref<'move' | 'add' | 'delete'>('move');

const geoJsonError = ref<string | null>(null);
const isDirty = ref(false);

function markDirty(): void {
    isDirty.value = true;
}

function confirmDiscard(href: string): void {
    if (
        isDirty.value &&
        !window.confirm('You have unsaved changes. Leave without saving?')
    ) {
        return;
    }

    router.get(href);
}

/**
 * Confirm an action that navigates away from the current line.
 *
 * The direction and refresh actions both go through Inertia, which replaces
 * the page and therefore throws away anything typed but not saved. The
 * unsaved-changes guard in confirmDiscard only covers deliberate navigation,
 * so without this the reviewer can edit a name, reach for "Invert directions"
 * and silently lose the edit.
 *
 * Deliberately a warning rather than disabling the buttons: hiding the
 * action leaves no visible reason why it cannot be used, and the reviewer has
 * no way to tell that is what happened.
 */
function confirmNavigation(message: string): boolean {
    if (isDirty.value) {
        return window.confirm(
            `${message}\n\nYou have unsaved edits on this form, and this will discard them.`,
        );
    }

    return window.confirm(message);
}

/**
 * Re-sync the editor when the server hands us a different line.
 *
 * Inertia reuses this component instance when navigating between two lines, so
 * setup does not run again and the textarea would keep the previous line's
 * geometry while the form action already pointed at the new line's id. Saving
 * would then write one line's geometry onto another.
 */
watch(
    () => props.line.geo_json,
    (geoJson) => {
        geoJsonText.value = geoJson ? JSON.stringify(geoJson, null, 2) : '';
        geoJsonError.value = null;
        isDirty.value = false;
    },
);

const canChangeDirection = computed(() => Boolean(props.counterpart));

const directionActions: {
    operation: DirectionOperation;
    label: string;
    icon: typeof Shuffle;
    confirm: string;
}[] = [
    {
        operation: 'invert',
        label: 'Invert directions',
        icon: ArrowRightLeft,
        confirm:
            'Reverse the point order of both this line and its counterpart?\n\n' +
            'Each direction keeps its own streets; only the direction of travel flips. ' +
            'Running this again restores the previous geometry.',
    },
    {
        operation: 'swap',
        label: 'Swap routes',
        icon: Shuffle,
        confirm:
            'Swap the geometry between this line and its counterpart?\n\n' +
            'This direction will then trace the streets its counterpart used. ' +
            'Name, color and syndicate stay with the sense they describe. ' +
            'Running this again restores the previous geometry.',
    },
];

function applyDirection(
    operation: DirectionOperation,
    confirmMessage: string,
): void {
    if (!canChangeDirection.value) {
        return;
    }

    if (!confirmNavigation(confirmMessage)) {
        return;
    }

    router.patch(LineController.directions.url({ line: props.line.id }), {
        operation,
    });
}

function refreshGeometry(): void {
    const warning = props.line.geometry_adjusted
        ? 'This line carries a manual correction. Restoring the source geometry discards it.\n\n'
        : '';

    if (
        !confirmNavigation(
            `${warning}Restore "${props.line.code}" from the source GeoJSON?\n\n` +
                'Precomputed transfers for this line will hold stale point indexes.',
        )
    ) {
        return;
    }

    router.post(LineController.refreshGeometry.url({ line: props.line.id }));
}

function toggleEditing(): void {
    if (isEditingMap.value) {
        mode.value = 'move';
    }

    isEditingMap.value = !isEditingMap.value;
}

function onMapUpdate(geoJson: NonNullable<Line['geo_json']>): void {
    geoJsonText.value = JSON.stringify(geoJson, null, 2);
    geoJsonError.value = null;
    markDirty();
}

function validateGeoJson(): void {
    if (!geoJsonText.value) {
        geoJsonError.value = null;

        return;
    }

    try {
        JSON.parse(geoJsonText.value);
        geoJsonError.value = null;
    } catch {
        geoJsonError.value = 'Invalid JSON format.';
    }
}

const pageTitle = computed(
    () =>
        `Edit: ${props.line.code} — ${props.line.sense === 'OUTBOUND' ? 'Ida' : 'Vuelta'}`,
);
</script>

<template>
    <Head :title="pageTitle" />
    <div class="flex items-center justify-between">
        <Button
            type="button"
            variant="ghost"
            size="sm"
            class="-ml-3"
            @click="confirmDiscard(lines.index.url())"
        >
            <ArrowLeft class="size-4" />
            Back to lines
        </Button>

        <div class="flex items-center gap-2">
            <Button
                v-if="props.counterpart"
                type="button"
                variant="secondary"
                size="sm"
                :title="`Switch to ${props.counterpart.code} (${props.counterpart.sense === 'OUTBOUND' ? 'Ida' : 'Vuelta'})`"
                @click="
                    confirmDiscard(
                        lines.edit.url({ line: props.counterpart!.id }),
                    )
                "
            >
                <ArrowLeftRight class="size-4" />
                {{ props.counterpart.sense === 'OUTBOUND' ? 'Ida' : 'Vuelta' }}
            </Button>

            <Button
                v-if="props.nav.prev"
                type="button"
                variant="outline"
                size="sm"
                :title="`Previous: ${props.nav.prev.code}`"
                @click="
                    confirmDiscard(lines.edit.url({ line: props.nav.prev!.id }))
                "
            >
                <ChevronLeft class="size-4" />
                Previous
            </Button>

            <Button
                v-if="props.nav.next"
                type="button"
                variant="outline"
                size="sm"
                :title="`Next: ${props.nav.next.code}`"
                @click="
                    confirmDiscard(lines.edit.url({ line: props.nav.next!.id }))
                "
            >
                Next
                <ChevronRight class="size-4" />
            </Button>
        </div>
    </div>
    <Heading
        :title="pageTitle"
        description="Update line name, color, syndicate, or route geometry"
    />

    <div class="grid gap-8 lg:grid-cols-2">
        <!-- Form -->
        <div>
            <Form
                v-bind="LineController.update.form(line.id)"
                class="grid grid-cols-2 gap-4"
                v-slot="{ errors, processing }"
            >
                <!-- Read-only fields -->
                <div class="grid gap-1">
                    <Label for="code">Code</Label>
                    <Input
                        id="code"
                        :model-value="line.code"
                        disabled
                        class="opacity-60"
                    />
                </div>

                <div class="grid gap-1">
                    <Label for="sense">Direction</Label>
                    <Input
                        id="sense"
                        :model-value="line.sense"
                        disabled
                        class="opacity-60"
                    />
                </div>

                <!-- Editable fields -->
                <div class="grid gap-1">
                    <Label for="name">Name</Label>
                    <Input
                        id="name"
                        name="name"
                        :default-value="line.name ?? ''"
                        placeholder="Line display name"
                        @input="markDirty"
                    />
                    <InputError :message="errors.name" />
                </div>

                <div class="grid grid-cols-2">
                    <div class="grid gap-2">
                        <Label for="color">Color</Label>
                        <div class="flex items-center gap-3">
                            <Input
                                id="color"
                                name="color"
                                :default-value="line.color ?? ''"
                                placeholder="#3b82f6"
                                class="w-32"
                                @input="markDirty"
                            />
                            <span
                                v-if="line.color"
                                class="inline-block h-6 w-6 rounded"
                                :style="{ backgroundColor: line.color }"
                            />
                        </div>
                        <InputError :message="errors.color" />
                    </div>

                    <div class="grid gap-2">
                        <Label for="syndicate">Syndicate</Label>
                        <Input
                            id="syndicate"
                            name="syndicate"
                            :default-value="line.syndicate ?? ''"
                            placeholder="Operating company"
                            @input="markDirty"
                        />
                        <InputError :message="errors.syndicate" />
                    </div>
                </div>

                <div class="col-span-2 grid gap-2">
                    <Label for="geo_json">Route geometry (GeoJSON)</Label>
                    <textarea
                        id="geo_json"
                        name="geo_json"
                        class="h-80 w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-xs"
                        :value="geoJsonText"
                        @input="
                            geoJsonText = ($event.target as HTMLTextAreaElement)
                                .value;
                            validateGeoJson();
                            markDirty();
                        "
                        placeholder='{"type":"MultiLineString","coordinates":[[[...]]]}'
                    ></textarea>
                    <InputError :message="errors.geo_json" />
                    <p
                        v-if="geoJsonError"
                        class="text-sm text-red-600 dark:text-red-500"
                    >
                        {{ geoJsonError }}
                    </p>
                </div>

                <div class="flex items-center gap-4">
                    <Button :disabled="processing">Save</Button>
                    <Button
                        type="button"
                        variant="outline"
                        :disabled="processing"
                        @click="confirmDiscard(lines.index.url())"
                    >
                        Cancel
                    </Button>
                </div>
            </Form>
        </div>

        <!-- Map preview / editor -->
        <div class="space-y-4">
            <div class="rounded-md border p-4">
                <div class="flex items-center justify-between">
                    <Label>Direction</Label>
                    <span
                        v-if="props.line.geometry_adjusted"
                        class="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                    >
                        Manually corrected
                    </span>
                </div>
                <p class="mt-2 text-sm text-muted-foreground">
                    The source data does not record which end a bus departs
                    from, so this is a manual correction. Both actions cover
                    this line and its counterpart, and both are undone by
                    repeating them.
                </p>
                <div class="mt-3 flex flex-wrap gap-2">
                    <Button
                        v-for="action in directionActions"
                        :key="action.operation"
                        type="button"
                        variant="outline"
                        size="sm"
                        :disabled="!canChangeDirection"
                        :title="
                            canChangeDirection
                                ? undefined
                                : 'This line has no counterpart to re-orient.'
                        "
                        @click="
                            applyDirection(action.operation, action.confirm)
                        "
                    >
                        <component :is="action.icon" class="size-4" />
                        {{ action.label }}
                    </Button>
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        title="Restore this line's geometry from the source GeoJSON"
                        @click="refreshGeometry"
                    >
                        <RotateCcw class="size-4" />
                        Reset to source
                    </Button>
                </div>
                <p
                    v-if="!canChangeDirection"
                    class="mt-2 text-sm text-muted-foreground"
                >
                    A line with no counterpart cannot be re-oriented. Circular
                    routes such as 72 and 73 are legitimately alone in their
                    direction.
                </p>
            </div>

            <div class="flex items-center justify-between">
                <Label>Route preview</Label>
                <Button
                    v-if="parsedGeoJson"
                    type="button"
                    variant="outline"
                    size="sm"
                    @click="toggleEditing"
                >
                    {{ isEditingMap ? 'Finish editing' : 'Edit route on map' }}
                </Button>
            </div>
            <div v-if="isEditingMap" class="flex flex-wrap gap-2">
                <Button
                    type="button"
                    :variant="mode === 'move' ? 'default' : 'outline'"
                    size="sm"
                    @click="mode = 'move'"
                >
                    Move
                </Button>
                <Button
                    type="button"
                    :variant="mode === 'add' ? 'default' : 'outline'"
                    size="sm"
                    @click="mode = 'add'"
                >
                    Add vertex
                </Button>
                <Button
                    type="button"
                    :variant="mode === 'delete' ? 'default' : 'outline'"
                    size="sm"
                    @click="mode = 'delete'"
                >
                    Delete vertex
                </Button>
            </div>
            <LineMap
                :geo-json="parsedGeoJson"
                :editable="isEditingMap"
                :mode="mode"
                @update:geo-json="onMapUpdate"
            />
            <p
                v-if="isEditingMap"
                class="text-sm text-blue-600 dark:text-blue-500"
            >
                <template v-if="mode === 'move'">
                    Drag the white dots to adjust the route geometry.
                </template>
                <template v-else-if="mode === 'add'">
                    Click on the route to add a new vertex.
                </template>
                <template v-else> Click a vertex to delete it. </template>
            </p>
            <p
                v-if="!parsedGeoJson && geoJsonText"
                class="text-sm text-red-600 dark:text-red-500"
            >
                Fix JSON errors to see the route on the map.
            </p>
        </div>
    </div>
</template>
