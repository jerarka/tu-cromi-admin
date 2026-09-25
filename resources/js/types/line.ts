export type LineSense = 'OUTBOUND' | 'RETURN';

export interface Line {
    id: number;
    code: string;
    name: string | null;
    color: string | null;
    geo_json: {
        type: 'MultiLineString';
        coordinates: number[][][];
    } | null;
    sense: LineSense;
    syndicate: string | null;
    objectid: number | null;
    parent_line_id: number | null;
    average_rating: number | null;
    total_reviews: number;
    created_at: string | null;
    updated_at: string | null;
    parent_line?: Pick<Line, 'id' | 'code' | 'sense'> | null;
}

export interface LineNav {
    prev: Pick<Line, 'id' | 'code' | 'sense'> | null;
    next: Pick<Line, 'id' | 'code' | 'sense'> | null;
}

export interface LineFilters {
    search?: string;
    sense?: string;
}
