<script setup lang="ts">
import { Form, Head, router } from '@inertiajs/vue3';
import { ArrowLeft } from '@lucide/vue';
import { computed, ref } from 'vue';
import LineController from '@/actions/App/Http/Controllers/Admin/LineController';
import Heading from '@/components/Heading.vue';
import InputError from '@/components/InputError.vue';
import LineMap from '@/components/lines/LineMap.vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import lines from '@/routes/lines';
import type { Line } from '@/types/line';

const geoJsonText = ref('');

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

function confirmDiscard(): void {
    if (
        isDirty.value &&
        !window.confirm('You have unsaved changes. Leave without saving?')
    ) {
        return;
    }

    router.get(lines.index.url());
}

function toggleEditing(): void {
    if (isEditingMap.value) {
        mode.value = 'move';
    } else if (!geoJsonText.value) {
        mode.value = 'add';
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
</script>

<template>
    <Head title="Create Line" />
    <Button
        type="button"
        variant="ghost"
        size="sm"
        class="-ml-3"
        @click="confirmDiscard"
    >
        <ArrowLeft class="size-4" />
        Back to lines
    </Button>
    <Heading
        title="Create Line"
        description="Add a new transport line and its route geometry"
    />

    <div class="grid gap-8 lg:grid-cols-2">
        <!-- Form -->
        <div>
            <Form
                v-bind="LineController.store.form()"
                class="grid grid-cols-2 gap-4"
                v-slot="{ errors, processing }"
            >
                <div class="grid gap-1">
                    <Label for="code">Code</Label>
                    <Input
                        id="code"
                        name="code"
                        placeholder="e.g. 1, 16 azul, 104 C"
                        @input="markDirty"
                    />
                    <InputError :message="errors.code" />
                </div>

                <div class="grid gap-1">
                    <Label for="sense">Direction</Label>
                    <select
                        id="sense"
                        name="sense"
                        class="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs"
                        @change="markDirty"
                    >
                        <option value="">Select direction...</option>
                        <option value="OUTBOUND">OUTBOUND (Ida)</option>
                        <option value="RETURN">RETURN (Vuelta)</option>
                    </select>
                    <InputError :message="errors.sense" />
                </div>

                <div class="grid gap-1">
                    <Label for="name">Name</Label>
                    <Input
                        id="name"
                        name="name"
                        placeholder="Line display name"
                        @input="markDirty"
                    />
                    <InputError :message="errors.name" />
                </div>

                <div class="grid grid-cols-2">
                    <div class="grid gap-2">
                        <Label for="color">Color</Label>
                        <Input
                            id="color"
                            name="color"
                            placeholder="#3b82f6"
                            class="w-32"
                            @input="markDirty"
                        />
                        <InputError :message="errors.color" />
                    </div>

                    <div class="grid gap-2">
                        <Label for="syndicate">Syndicate</Label>
                        <Input
                            id="syndicate"
                            name="syndicate"
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
                        @click="confirmDiscard"
                    >
                        Cancel
                    </Button>
                </div>
            </Form>
        </div>

        <!-- Map preview / editor -->
        <div class="space-y-4">
            <div class="flex items-center justify-between">
                <Label>Route preview</Label>
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    @click="toggleEditing"
                >
                    {{
                        isEditingMap
                            ? 'Finish editing'
                            : parsedGeoJson
                              ? 'Edit route on map'
                              : 'Draw route on map'
                    }}
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
                <template v-if="!parsedGeoJson">
                    Click on the map to place the first vertex, then keep
                    clicking to build the route.
                </template>
                <template v-else-if="mode === 'move'">
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
