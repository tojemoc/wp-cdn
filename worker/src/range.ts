export interface RangeInfo {
	start: number;
	end: number;
	length: number;
	isPartial: boolean;
}

export function parseRangeHeader(rangeHeader: string | null, totalSize: number): RangeInfo | null {
	if (!rangeHeader || !rangeHeader.startsWith("bytes=")) {
		return null;
	}
	const rangeSpec = rangeHeader.substring(6).trim();
	if (rangeSpec.includes(",")) {
		return null;
	}
	const dashIndex = rangeSpec.indexOf("-");
	if (dashIndex === -1) {
		return null;
	}
	const startStr = rangeSpec.substring(0, dashIndex);
	const endStr = rangeSpec.substring(dashIndex + 1);
	let start: number;
	let end: number;
	if (startStr === "") {
		const suffix = parseInt(endStr, 10);
		if (isNaN(suffix) || suffix <= 0) return null;
		start = Math.max(0, totalSize - suffix);
		end = totalSize - 1;
	} else if (endStr === "") {
		start = parseInt(startStr, 10);
		if (isNaN(start) || start < 0) return null;
		end = totalSize - 1;
	} else {
		start = parseInt(startStr, 10);
		end = parseInt(endStr, 10);
		if (isNaN(start) || isNaN(end) || start < 0) return null;
	}
	end = Math.min(end, totalSize - 1);
	if (start > end || start >= totalSize) {
		return null;
	}
	return {
		start,
		end,
		length: end - start + 1,
		isPartial: !(start === 0 && end === totalSize - 1)
	};
}

export function buildContentRangeHeader(start: number, end: number, totalSize: number): string {
	return `bytes ${start}-${end}/${totalSize}`;
}
