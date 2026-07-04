<script setup lang="ts">
import { Head, Link, router, usePage } from '@inertiajs/vue3';
import { ref } from 'vue';
import Heading from '@/components/Heading.vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { Line, LineFilters } from '@/types/line';

interface PaginatedLines {
    data: Line[];
    current_page: number;
    last_page: number;
    from: number | null;
    to: number | null;
    total: number;
    links: Array<{
        url: string | null;
        label: string;
        active: boolean;
    }>;
}

const props = defineProps<{
    lines: PaginatedLines;
    filters: LineFilters;
}>();

const search = ref(props.filters.search ?? '');
const sense = ref(props.filters.sense ?? '');

function applyFilters(): void {
    router.get(
        '/lines',
        {
            search: search.value || undefined,
            sense: sense.value || undefined,
        },
        {
            preserveState: true,
            replace: true,
        },
    );
}

function visitPage(url: string | null): void {
    if (!url) {
        return;
    }

    router.get(
        url,
        {},
        {
            preserveState: true,
            replace: true,
        },
    );
}

const page = usePage();

const senseBadge = (sense: string): string => {
    return sense === 'OUTBOUND'
        ? 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200'
        : 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200';
};

const senseLabel = (sense: string): string => {
    return sense === 'OUTBOUND' ? 'Ida' : 'Vuelta';
};
</script>

<template>
    <Head title="Lines" />

    <Heading
        title="Lines"
        description="Manage transport lines and their routes"
    />

    <!-- Filters -->
    <div class="mb-6 flex flex-wrap items-end gap-4">
        <div class="grid gap-2">
            <Label for="search">Search</Label>
            <Input
                id="search"
                v-model="search"
                placeholder="Search by code or name..."
                class="w-64"
                @keydown.enter="applyFilters"
            />
        </div>

        <div class="grid gap-2">
            <Label for="sense">Direction</Label>
            <select
                id="sense"
                v-model="sense"
                class="h-9 w-40 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs"
                @change="applyFilters"
            >
                <option value="">All</option>
                <option value="OUTBOUND">OUTBOUND (Ida)</option>
                <option value="RETURN">RETURN (Vuelta)</option>
            </select>
        </div>

        <Button
            variant="secondary"
            @click="
                search = '';
                sense = '';
                applyFilters();
            "
        >
            Reset
        </Button>
    </div>

    <!-- Table -->
    <div class="overflow-x-auto rounded-md border">
        <table class="w-full text-sm">
            <thead>
                <tr class="border-b bg-muted/50">
                    <th class="px-4 py-3 text-left font-medium">Code</th>
                    <th class="px-4 py-3 text-left font-medium">Name</th>
                    <th class="px-4 py-3 text-left font-medium">Color</th>
                    <th class="px-4 py-3 text-left font-medium">Direction</th>
                    <th class="px-4 py-3 text-left font-medium">Syndicate</th>
                    <th class="px-4 py-3 text-center font-medium">Rating</th>
                    <th class="px-4 py-3 text-center font-medium">Reviews</th>
                    <th class="px-4 py-3 text-right font-medium">Actions</th>
                </tr>
            </thead>
            <tbody>
                <tr
                    v-for="line in lines.data"
                    :key="line.id"
                    class="border-b last:border-0 hover:bg-muted/30"
                >
                    <td class="px-4 py-3 font-medium">{{ line.code }}</td>
                    <td class="px-4 py-3 text-muted-foreground">
                        {{ line.name ?? '—' }}
                    </td>
                    <td class="px-4 py-3">
                        <span
                            v-if="line.color"
                            class="inline-block h-5 w-5 rounded"
                            :style="{ backgroundColor: line.color }"
                            :title="line.color"
                        />
                        <span v-else class="text-muted-foreground">—</span>
                    </td>
                    <td class="px-4 py-3">
                        <span
                            class="inline rounded-full px-2.5 py-0.5 text-xs font-medium"
                            :class="senseBadge(line.sense)"
                        >
                            {{ senseLabel(line.sense) }}
                        </span>
                    </td>
                    <td class="px-4 py-3 text-muted-foreground">
                        {{ line.syndicate ?? '—' }}
                    </td>
                    <td class="px-4 py-3 text-center">
                        {{ line.average_rating ?? '—' }}
                    </td>
                    <td class="px-4 py-3 text-center">
                        {{ line.total_reviews }}
                    </td>
                    <td class="px-4 py-3 text-right">
                        <Button variant="outline" size="sm" as-child>
                            <Link :href="`/lines/${line.id}/edit`">Edit</Link>
                        </Button>
                    </td>
                </tr>
                <tr v-if="lines.data.length === 0">
                    <td
                        colspan="8"
                        class="px-4 py-8 text-center text-muted-foreground"
                    >
                        No lines found.
                    </td>
                </tr>
            </tbody>
        </table>
    </div>

    <!-- Pagination -->
    <div
        v-if="lines.last_page > 1"
        class="mt-4 flex items-center justify-between"
    >
        <p class="text-sm text-muted-foreground">
            Showing {{ lines.from }}–{{ lines.to }} of {{ lines.total }}
        </p>

        <nav class="flex items-center gap-1">
            <Button
                v-for="(link, i) in lines.links"
                :key="i"
                :variant="link.active ? 'default' : 'outline'"
                size="sm"
                :disabled="!link.url"
                @click="visitPage(link.url)"
                v-html="link.label"
            />
        </nav>
    </div>
</template>
