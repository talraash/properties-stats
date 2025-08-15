import { App, Plugin, TFile, Modal, ButtonComponent, Menu, Notice, FileSystemAdapter, TAbstractFile, Setting, PluginSettingTab } from 'obsidian';

interface FrontmatterField {
    name: string;
    count: number;
    files: TFile[];
    valueStats?: {
        unique: number;
        topValues: { value: string, count: number }[];
        typeDistribution: { type: string, count: number }[];
    };
}

interface PluginSettings {
    pageSize: number;
    ignoreFields: string[];
    cacheTTL: number;
    analyzeValues: boolean;
    showProgress: boolean;
}

const DEFAULT_SETTINGS: PluginSettings = {
    pageSize: 50,
    ignoreFields: [],
    cacheTTL: 600,
    analyzeValues: false,
    showProgress: true
};

export default class EnhancedFrontmatterStatsPlugin extends Plugin {
    settings!: PluginSettings;
    private cache: FrontmatterField[] = [];
    private lastUpdate = 0;
    private progressCallback: ((progress: number) => void) | null = null;

    async onload() {
        await this.loadSettings();
        
        this.addRibbonIcon('list', 'Frontmatter Statistics', () => {
            new StatsModal(this.app, this).open();
        });

        this.registerEvent(this.app.metadataCache.on('changed', (file) => this.updateCacheForFile(file)));
        this.registerEvent(this.app.vault.on('delete', (file) => this.updateCacheOnDelete(file)));
        this.registerEvent(this.app.vault.on('rename', (file, oldPath) => this.updateCacheOnRename(file, oldPath)));
        this.registerEvent(this.app.vault.on('create', (file) => this.updateCacheOnCreate(file)));

        this.addCommand({
            id: 'show-frontmatter-stats',
            name: 'Show Frontmatter Statistics',
            callback: () => {
                new StatsModal(this.app, this).open();
            }
        });

        this.addSettingTab(new FrontmatterStatsSettingTab(this.app, this));
    }

    private updateCacheForFile(file: TFile) {
        if (file.extension !== 'md') return;
        
        // Delete old data from cache
        this.cache = this.cache.map(field => ({
            ...field,
            files: field.files.filter(f => f.path !== file.path),
            count: field.files.filter(f => f.path !== file.path).length
        })).filter(field => field.count > 0);
        
        // Cache addition new data
        this.addFileToCache(file);
    }

    private updateCacheOnDelete(file: TAbstractFile) {
        if (!(file instanceof TFile) || file.extension !== 'md') return;
        
        this.cache = this.cache.map(field => ({
            ...field,
            files: field.files.filter(f => f.path !== file.path),
            count: field.files.filter(f => f.path !== file.path).length
        })).filter(field => field.count > 0);
    }

    private updateCacheOnRename(file: TAbstractFile, oldPath: string) {
        if (!(file instanceof TFile) || file.extension !== 'md') return;
        
        this.cache = this.cache.map(field => ({
            ...field,
            files: field.files.map(f => f.path === oldPath ? file : f)
        }));
    }

    private updateCacheOnCreate(file: TAbstractFile) {
        if (file instanceof TFile && file.extension === 'md') {
            this.addFileToCache(file);
        }
    }

    private addFileToCache(file: TFile) {
        const cache = this.app.metadataCache.getFileCache(file);
        if (!cache?.frontmatter) return;

        const entries = this.flattenFrontmatter(cache.frontmatter);
        const ignoreSet = new Set(this.settings.ignoreFields);

        for (const [key, value] of entries) {
            if (ignoreSet.has(key)) continue;
            
            let field = this.cache.find(f => f.name === key);
            if (!field) {
                field = { name: key, count: 0, files: [] };
                this.cache.push(field);
            }
            
            if (!field.files.some(f => f.path === file.path)) {
                field.files.push(file);
                field.count++;
            }
        }
        
        this.lastUpdate = Date.now();
    }

    clearCache() {
        this.cache = [];
        this.lastUpdate = 0;
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    async getFields(progressCallback?: (progress: number) => void): Promise<FrontmatterField[]> {
        if (this.cache.length > 0 && Date.now() - this.lastUpdate < this.settings.cacheTTL * 1000) {
            return this.cache;
        }

        const fieldsMap: Record<string, FrontmatterField> = {};
        const markdownFiles = this.app.vault.getMarkdownFiles();
        const ignoreSet = new Set(this.settings.ignoreFields);
        const totalFiles = markdownFiles.length;
        let processedFiles = 0;

        for (const file of markdownFiles) {
            const cache = this.app.metadataCache.getFileCache(file);
            if (!cache?.frontmatter) {
                processedFiles++;
                if (progressCallback) progressCallback((processedFiles / totalFiles) * 100);
                continue;
            }

            const entries = this.flattenFrontmatter(cache.frontmatter);
            for (const [key, value] of entries) {
                if (ignoreSet.has(key)) continue;
                
                if (!fieldsMap[key]) {
                    fieldsMap[key] = { 
                        name: key, 
                        count: 0, 
                        files: [],
                        valueStats: this.settings.analyzeValues ? {
                            unique: 0,
                            topValues: [],
                            typeDistribution: []
                        } : undefined
                    };
                }
                
                if (!fieldsMap[key].files.some(f => f.path === file.path)) {
                    fieldsMap[key].count++;
                    fieldsMap[key].files.push(file);
                    
                    if (this.settings.analyzeValues && fieldsMap[key].valueStats) {
                        this.updateValueStats(fieldsMap[key].valueStats!, value);
                    }
                }
            }

            processedFiles++;
            if (progressCallback && this.settings.showProgress) {
                progressCallback((processedFiles / totalFiles) * 100);
            }
        }

        if (this.settings.analyzeValues) {
            for (const field of Object.values(fieldsMap)) {
                if (field.valueStats) {
                    field.valueStats.topValues = field.valueStats.topValues
                        .sort((a, b) => b.count - a.count)
                        .slice(0, 5);
                }
            }
        }

        this.cache = Object.values(fieldsMap).sort((a, b) => b.count - a.count);
        this.lastUpdate = Date.now();
        return this.cache;
    }

    private updateValueStats(stats: NonNullable<FrontmatterField['valueStats']>, value: any) {
        let type = Array.isArray(value) ? 'array' : typeof value;
        if (value === null) type = 'null';
        const typeEntry = stats.typeDistribution.find(t => t.type === type);
        if (typeEntry) {
            typeEntry.count++;
        } else {
            stats.typeDistribution.push({ type, count: 1 });
        }

        // Unique value count
        if (type !== 'object' && type !== 'array') {
            const valueStr = String(value);
            const valueEntry = stats.topValues.find(v => v.value === valueStr);
            if (valueEntry) {
                valueEntry.count++;
            } else {
                stats.topValues.push({ value: valueStr, count: 1 });
                stats.unique = stats.topValues.length;
            }
        }
    }

    private flattenFrontmatter(obj: any, prefix = ''): [string, any][] {
        let result: [string, any][] = [];
        
        for (const [key, value] of Object.entries(obj)) {
            const fullKey = prefix ? `${prefix}.${key}` : key;
            
            if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
                result = [...result, ...this.flattenFrontmatter(value, fullKey)];
            } else {
                result.push([fullKey, value]);
            }
        }
        
        return result;
    }
}

class StatsModal extends Modal {
    private fields: FrontmatterField[] = [];
    private currentField: FrontmatterField | null = null;
    private currentPage = 0;
    private filterTerm = '';
    private debounceTimeout: number | null = null;
    private plugin: EnhancedFrontmatterStatsPlugin;
    private searchInputEl: HTMLInputElement | null = null;
    private isLoading = true;
    private progress = 0;

    constructor(app: App, plugin: EnhancedFrontmatterStatsPlugin) {
        super(app);
        this.plugin = plugin;
    }

    async onOpen() {
        this.renderLoadingView();
        this.fields = await this.plugin.getFields((progress) => {
            this.progress = progress;
            this.updateProgressBar();
        });
        this.isLoading = false;
        this.renderMainView();
    }

    private renderLoadingView() {
        this.contentEl.empty();
        this.contentEl.addClass('frontmatter-stats');
        
        this.contentEl.createEl('h2', { text: 'Frontmatter Statistics' });
        
        const progressContainer = this.contentEl.createDiv({ cls: 'progress-container' });
        progressContainer.createEl('p', { text: 'Scanning your vault...' });
        
        const progressBar = progressContainer.createDiv({ cls: 'progress-bar' });
        const progressFill = progressBar.createDiv({ cls: 'progress-fill' });
        
        this.updateProgressBar = () => {
            progressFill.style.width = `${this.progress}%`;
        };
    }

    private updateProgressBar() {
        // ToDo: Implement progress bar update logic
    }

    onClose() {
        this.contentEl.empty();
        if (this.debounceTimeout) {
            clearTimeout(this.debounceTimeout);
        }
        this.searchInputEl = null;
    }

    private renderMainView() {
        this.contentEl.empty();
        this.contentEl.addClass('frontmatter-stats');
        
        this.contentEl.createEl('h2', { text: 'Frontmatter Statistics' });
        
        // Export button
        const exportButton = new ButtonComponent(this.contentEl)
            .setButtonText('Export CSV')
            .onClick(() => this.exportCSV());
        exportButton.buttonEl.style.marginLeft = '10px';
        
        // Search
        const searchContainer = this.contentEl.createDiv({ cls: 'search-container' });
        searchContainer.createEl('label', { 
            text: 'Search:',
            attr: { for: 'frontmatter-search' }
        });
        
        this.searchInputEl = searchContainer.createEl('input', {
            type: 'text',
            attr: { 
                id: 'frontmatter-search', 
                placeholder: 'Filter parameters...' 
            },
            value: this.filterTerm
        }) as HTMLInputElement;
        
        this.searchInputEl.addEventListener('input', (e) => {
            this.filterTerm = (e.target as HTMLInputElement).value.toLowerCase();
            
            if (this.debounceTimeout) {
                clearTimeout(this.debounceTimeout);
            }
            
            this.debounceTimeout = window.setTimeout(() => {
                this.renderTable();
            }, 300);
        });
        
        this.renderTable();
    }

    private renderTable() {
        const existingTable = this.contentEl.querySelector('table');
        if (existingTable) existingTable.remove();
        
        const noResults = this.contentEl.querySelector('p.no-results');
        if (noResults) noResults.remove();
        
        const filteredFields = this.filterTerm ? 
            this.fields.filter(f => f.name.toLowerCase().includes(this.filterTerm)) : 
            this.fields;
        
        if (filteredFields.length === 0) {
            this.contentEl.createEl('p', { 
                text: 'No matching parameters found',
                cls: 'no-results'
            });
            return;
        }
        
        const table = this.contentEl.createEl('table');
        const headerRow = table.createEl('tr');
        headerRow.createEl('th', { text: 'Field' });
        headerRow.createEl('th', { text: 'Count' });
        headerRow.createEl('th', { text: 'Unique Values' }).title = 'When value analysis is enabled';
        headerRow.createEl('th', { text: 'Actions' });

        for (const field of filteredFields) {
            const row = table.createEl('tr');
            row.createEl('td', { text: field.name });
            row.createEl('td', { text: field.count.toString() });
            
            const uniqueCell = row.createEl('td');
            if (this.plugin.settings.analyzeValues && field.valueStats) {
                uniqueCell.textContent = `${field.valueStats.unique}`;
                uniqueCell.title = `Top values: ${field.valueStats.topValues.map(v => `${v.value} (${v.count})`).join(', ')}`;
            } else {
                uniqueCell.textContent = '-';
            }
            
            const actionCell = row.createEl('td');
            const showNotesButton = new ButtonComponent(actionCell)
                .setButtonText('Show Notes')
                .onClick(() => {
                    this.currentField = field;
                    this.currentPage = 0;
                    this.renderFileList();
                });
                
            row.oncontextmenu = (e) => {
                e.preventDefault();
                this.showFieldContextMenu(field, e);
            };
        }
    }

    private showFieldContextMenu(field: FrontmatterField, e: MouseEvent) {
        const menu = new Menu();
        
        menu.addItem(item => item
            .setTitle("Add to ignore list")
            .setIcon('eye-off')
            .onClick(() => {
                this.plugin.settings.ignoreFields.push(field.name);
                this.plugin.saveSettings();
                this.plugin.clearCache();
                new Notice(`Added "${field.name}" to ignore list`);
                this.fields = this.fields.filter(f => f.name !== field.name);
                this.renderTable();
            }));
            
        if (this.plugin.settings.analyzeValues && field.valueStats) {
            menu.addItem(item => item
                .setTitle("Export value statistics")
                .setIcon('download')
                .onClick(() => this.exportValueStatsCSV(field)));
        }
        
        menu.showAtPosition({ x: e.pageX, y: e.pageY });
    }

    private renderFileList() {
        if (!this.currentField) return;
        
        this.contentEl.empty();
        this.contentEl.addClass('frontmatter-stats');
        
        this.contentEl.createEl('h2', { 
            text: `Notes with "${this.currentField.name}"` 
        });
        
        const controls = this.contentEl.createDiv({ cls: 'file-list-controls' });
        
        const backButton = new ButtonComponent(controls)
            .setButtonText('← Back')
            .onClick(() => {
                this.currentField = null;
                this.currentPage = 0;
                this.renderMainView();
            });
            
        const exportButton = new ButtonComponent(controls)
            .setButtonText('Export File List')
            .onClick(() => this.exportFileListCSV());
        
        // List of files
        const start = this.currentPage * this.plugin.settings.pageSize;
        const end = start + this.plugin.settings.pageSize;
        const paginatedFiles = this.currentField.files.slice(start, end);
        
        const list = this.contentEl.createEl('ul', { cls: 'file-list' });
        
        for (const file of paginatedFiles) {
            const cache = this.app.metadataCache.getFileCache(file);
            const frontmatterValue = cache?.frontmatter 
                ? this.getNestedValue(cache.frontmatter, this.currentField.name) 
                : 'N/A';
                
            const item = list.createEl('li');
            const link = item.createEl('a', {
                text: file.basename,
                href: '#',
                cls: 'internal-link'
            });
            
            const valueSpan = item.createSpan({
                text: `: ${this.truncate(String(frontmatterValue), 50)}`,
                cls: 'file-value'
            });
            valueSpan.title = String(frontmatterValue);
            
            link.onclick = (e) => {
                e.preventDefault();
                this.openFile(file);
            };
            
            link.oncontextmenu = (e) => {
                e.preventDefault();
                this.showFileContextMenu(file, e);
            };
        }
        
        // Pagination
        this.renderPagination();
    }

    private renderPagination() {
        if (!this.currentField || this.currentField.files.length <= this.plugin.settings.pageSize) return;
        
        const totalPages = Math.ceil(this.currentField.files.length / this.plugin.settings.pageSize);
        const pagination = this.contentEl.createDiv({ cls: 'pagination' });
        
        if (this.currentPage > 0) {
            new ButtonComponent(pagination)
                .setButtonText('← Previous')
                .onClick(() => {
                    this.currentPage--;
                    this.renderFileList();
                });
        }
        
        pagination.createSpan({ 
            text: ` ${this.currentPage + 1} / ${totalPages} `,
            cls: 'page-info'
        });
        
        if (this.currentPage < totalPages - 1) {
            new ButtonComponent(pagination)
                .setButtonText('Next →')
                .onClick(() => {
                    this.currentPage++;
                    this.renderFileList();
                });
        }
    }

    private getNestedValue(obj: any, path: string): any {
        return path.split('.').reduce((acc, part) => {
            if (acc && typeof acc === 'object' && part in acc) {
                return acc[part];
            }
            return undefined;
        }, obj);
    }

    private truncate(text: string, maxLength: number): string {
        return text.length > maxLength ? text.slice(0, maxLength) + '...' : text;
    }

    private showFileContextMenu(file: TFile, e: MouseEvent) {
        const menu = new Menu(); 
        
        menu.addItem(item => item
            .setTitle("Open in current tab")
            .setIcon('document')
            .onClick(() => this.openFile(file)));
            
        menu.addItem(item => item
            .setTitle("Open in new tab")
            .setIcon('layout')
            .onClick(() => this.openFile(file, true)));
            
        menu.addItem(item => item
            .setTitle("Copy file path")
            .setIcon('copy')
            .onClick(() => navigator.clipboard.writeText(file.path)));
            
        menu.addItem(item => item
            .setTitle("Reveal in file explorer")
            .setIcon('folder')
            .onClick(() => {
                if (typeof window.require === 'function') {
                    try {
                        const { shell } = window.require('electron');
                        const adapter = this.app.vault.adapter;
                        if (adapter instanceof FileSystemAdapter) {
                            const fullPath = adapter.getFullPath(file.path);
                            shell.showItemInFolder(fullPath);
                        }
                    } catch (error) {
                        new Notice('Failed to reveal file: ' + error);
                    }
                } else {
                    new Notice('This feature is only available in the desktop app');
                }
            }));
            
        menu.showAtPosition({ x: e.pageX, y: e.pageY });
    }

    private openFile(file: TFile, newPane = false) {
        if (newPane) {
            const leaf = this.app.workspace.getLeaf('split', 'vertical');
            leaf.openFile(file);
        } else {
            this.app.workspace.getLeaf(false).openFile(file);
        }
        this.close();
    }

    private exportCSV() {
        const headers = ['Field', 'Count', 'Unique Values', 'Top Values'];
        const rows = this.fields.map(field => {
            const topValues = this.plugin.settings.analyzeValues && field.valueStats
                ? field.valueStats.topValues.map(v => `${v.value} (${v.count})`).join('; ')
                : '';
                
            return [
                `"${field.name}"`,
                field.count,
                this.plugin.settings.analyzeValues && field.valueStats ? field.valueStats.unique : '',
                `"${topValues}"`
            ].join(',');
        });
        
        const csvContent = [headers.join(','), ...rows].join('\n');
        this.downloadFile('frontmatter-stats.csv', csvContent);
    }

    private exportValueStatsCSV(field: FrontmatterField) {
        if (!field.valueStats) return;
        
        const headers = ['Value', 'Count', 'Percentage'];
        const total = field.count;
        
        const rows = field.valueStats.topValues.map(value => {
            const percentage = ((value.count / total) * 100).toFixed(2);
            return [
                `"${value.value}"`,
                value.count,
                `${percentage}%`
            ].join(',');
        });
        
        const csvContent = [headers.join(','), ...rows].join('\n');
        this.downloadFile(`${field.name}-values.csv`, csvContent);
    }

    private exportFileListCSV() {
        if (!this.currentField) return;
        
        const headers = ['File', 'Path', 'Value'];
        const rows = this.currentField.files.map(file => {
            const cache = this.app.metadataCache.getFileCache(file);
            const value = cache?.frontmatter 
                ? this.getNestedValue(cache.frontmatter, this.currentField!.name) 
                : '';
                
            return [
                `"${file.basename}"`,
                `"${file.path}"`,
                `"${value}"`
            ].join(',');
        });
        
        const csvContent = [headers.join(','), ...rows].join('\n');
        this.downloadFile(`${this.currentField.name}-files.csv`, csvContent);
    }

    private downloadFile(filename: string, content: string) {
        const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.click();
        URL.revokeObjectURL(url);
    }
}

class FrontmatterStatsSettingTab extends PluginSettingTab {
    plugin: EnhancedFrontmatterStatsPlugin;

    constructor(app: App, plugin: EnhancedFrontmatterStatsPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'Frontmatter Statistics Settings' });

        new Setting(containerEl)
            .setName('Cache duration (seconds)')
            .setDesc('How long to keep statistics before recalculating')
            .addText(text => text
                .setValue(String(this.plugin.settings.cacheTTL))
                .onChange(async (value) => {
                    this.plugin.settings.cacheTTL = Number(value) || 300;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Page size')
            .setDesc('Number of files to show per page')
            .addText(text => text
                .setValue(String(this.plugin.settings.pageSize))
                .onChange(async (value) => {
                    this.plugin.settings.pageSize = Number(value) || 50;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Enable value analysis')
            .setDesc('Collect detailed statistics on field values (may impact performance)')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.analyzeValues)
                .onChange(async (value) => {
                    this.plugin.settings.analyzeValues = value;
                    await this.plugin.saveSettings();
                    this.plugin.clearCache();
                }));

        new Setting(containerEl)
            .setName('Show progress bar')
            .setDesc('Display progress during initial scan')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showProgress)
                .onChange(async (value) => {
                    this.plugin.settings.showProgress = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Ignored fields')
            .setDesc('Fields to exclude from statistics (one per line)')
            .addTextArea(text => {
                text
                    .setValue(this.plugin.settings.ignoreFields.join('\n'))
                    .onChange(async (value) => {
                        this.plugin.settings.ignoreFields = value
                            .split('\n')
                            .map(f => f.trim())
                            .filter(f => f);
                        await this.plugin.saveSettings();
                        this.plugin.clearCache();
                    });
                text.inputEl.rows = 5;
                text.inputEl.cols = 50;
            });
    }
}