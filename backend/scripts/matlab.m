folder = uigetdir(pwd, 'Select folder containing CSV files');
if isequal(folder, 0)
    error('No folder selected.');
end

files = dir(fullfile(folder, '*.csv'));
if isempty(files)
    error('No CSV files found in selected folder.');
end

allData = cell(numel(files), 1);
for fi = 1:numel(files)
    filePath = fullfile(folder, files(fi).name);
    try
        tableData = readtable(filePath);
    catch
        warning('Failed to read %s - skipping.', files(fi).name);
        continue;
    end
    allData{fi} = struct('T', tableData, 'name', files(fi).name);
end

allData = allData(~cellfun(@isempty, allData));
n = numel(allData);
if n == 0
    error('No readable CSV files found.');
end

time_header = "Timestamp_yyyy_mm_ddHh_mm_ss_000_";
methane_header = "Methane_ppm_m_";
distance_header = "Distance_m_";
methane_valid_header = "MethaneValid";

for k = 1:n
    data = allData{k};
    [~, displayName, ~] = fileparts(data.name);
    [time, rawPpm, background, corrected] = extract_raw_and_corrected_series( ...
        data.T, time_header, methane_header, distance_header, methane_valid_header);

    figure('Name', sprintf('%s Raw and Corrected Methane', displayName), 'NumberTitle', 'off');
    tl = tiledlayout(1, 2, 'Padding', 'loose', 'TileSpacing', 'compact');

    nexttile;
    if isempty(time)
        title(sprintf('%s (no valid data)', displayName), 'Interpreter', 'none');
        axis off;
    else
        plot(time, rawPpm, '-r', 'LineWidth', 1.2);
        hold on;
        if ~isnan(background)
            yline(background, 'b--', 'LineWidth', 1.2);
        end
        hold off;
        title('Raw PPM vs Time');
        xlabel('Time');
        ylabel('Raw Methane (ppm)');
        grid on;
        if isnan(background)
            legend('Raw Methane (ppm)', 'Location', 'best');
        else
            legend('Raw Methane (ppm)', 'Background', 'Location', 'best');
        end
    end

    nexttile;
    if isempty(time)
        title(sprintf('%s (no valid data)', displayName), 'Interpreter', 'none');
        axis off;
    else
        plot(time, corrected, '-g', 'LineWidth', 1.2);
        hold on;
        yline(0, 'k--', 'LineWidth', 1.2);
        hold off;
        maxCorrected = max(corrected, [], 'omitnan');
        if ~isfinite(maxCorrected) || maxCorrected <= 0
            maxCorrected = 1;
        end
        ylim([0, maxCorrected]);
        title('Corrected PPM vs Time');
        xlabel('Time');
        ylabel('Corrected Methane (ppm)');
        grid on;
        legend('Corrected Methane (ppm)', 'Zero Line', 'Location', 'best');
    end

    title(tl, sprintf('%s Raw and Corrected Methane', displayName), 'Interpreter', 'none');
    annotation('textbox', [0.34 0.001 0.32 0.03], 'String', sprintf('Background: %.6f ppm', background), ...
        'EdgeColor', 'none', 'HorizontalAlignment', 'center', 'FontWeight', 'bold');
end

function [time, rawPpm, background, corrected] = extract_raw_and_corrected_series(T, timeHeader, methaneHeader, distanceHeader, methaneValidHeader)
timeIdx = find_col(T, timeHeader);
methaneIdx = find_col(T, methaneHeader);
distanceIdx = find_col(T, distanceHeader);
validIdx = find_col(T, methaneValidHeader);

if isempty(timeIdx) || isempty(methaneIdx) || isempty(distanceIdx)
    time = datetime.empty(0, 1);
    rawPpm = [];
    background = NaN;
    corrected = [];
    return;
end

time = normalize_time_column(T{:, timeIdx});
rawPpm = normalize_numeric_column(T{:, methaneIdx});
distance = normalize_numeric_column(T{:, distanceIdx});
methaneValid = [];

if ~isempty(validIdx)
    methaneValid = normalize_numeric_column(T{:, validIdx});
    invalidMask = (methaneValid == 0) | isnan(methaneValid);
    rawPpm(invalidMask) = NaN;
end

distanceZeroMask = distance == 0;
rawPpm(distanceZeroMask) = NaN;

validMask = ~isnat(time) & ~isnan(rawPpm) & ~isnan(distance) & ~distanceZeroMask;
time = time(validMask);
rawPpm = rawPpm(validMask);
distance = distance(validMask);
if ~isempty(methaneValid)
    methaneValid = methaneValid(validMask);
end

rawPpm = rawPpm ./ distance;

if isempty(time)
    background = NaN;
    corrected = [];
    return;
end

[time, order] = sort(time);
rawPpm = rawPpm(order);
if ~isempty(methaneValid)
    methaneValid = methaneValid(order);
end

background = compute_background(rawPpm);
corrected = rawPpm - background;

% Drop methane_valid == 2 only after background estimation.
if ~isempty(methaneValid)
    postBackgroundMask = methaneValid ~= 2;
    time = time(postBackgroundMask);
    rawPpm = rawPpm(postBackgroundMask);
    corrected = corrected(postBackgroundMask);
end
end

function time = normalize_time_column(values)
if isnumeric(values)
    try
        time = datetime(values, 'ConvertFrom', 'posixtime');
    catch
        time = datetime(values, 'ConvertFrom', 'datenum');
    end
else
    time = datetime(values);
end

time = time(:);
end

function values = normalize_numeric_column(values)
if isnumeric(values)
    values = double(values);
else
    values = str2double(string(values));
end

values = values(:);
end

function background = compute_background(rawPpm)
positive = rawPpm(rawPpm > 0 & ~isnan(rawPpm));

if isempty(positive)
    background = NaN;
    return;
end

[counts, edges] = histcounts(positive, 'BinMethod', 'auto');
if numel(counts) < 2
    p20 = prctile(positive, 20);
    background = median(positive(positive <= p20));
    if isnan(background)
        background = median(positive);
    end
    return;
end

[~, idxs] = maxk(counts, min(2, numel(counts)));
selected = [];
for ii = 1:numel(idxs)
    binLo = edges(idxs(ii));
    binHi = edges(idxs(ii) + 1);
    selected = [selected; positive(positive >= binLo & positive < binHi)]; %#ok<AGROW>
end

if isempty(selected)
    p20 = prctile(positive, 20);
    background = median(positive(positive <= p20));
    if isnan(background)
        background = median(positive);
    end
else
    p20c = prctile(selected, 20);
    lows = selected(selected <= p20c);
    if isempty(lows)
        background = min(selected);
    else
        background = median(lows);
    end
end
end

function idx = find_col(tbl, aliases)
names = string(tbl.Properties.VariableNames);
aliases = string(aliases);

idx = find(ismember(names, aliases), 1);
if isempty(idx)
    idx = find(ismember(lower(names), lower(aliases)), 1);
end
end