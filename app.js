// 定数定義
const NETWORKS = {
    1: {
        name: 'Ethereum',
        rpcUrl: 'https://ethereum.publicnode.com',
        symbol: 'ETH'
    },
    137: {
        name: 'Polygon',
        rpcUrl: 'https://polygon-rpc.com',
        symbol: 'MATIC'
    },
    56: {
        name: 'BSC',
        rpcUrl: 'https://bsc-dataseed.binance.org',
        symbol: 'BNB'
    },
    42161: {
        name: 'Arbitrum',
        rpcUrl: 'https://arb1.arbitrum.io/rpc',
        symbol: 'ETH'
    }
};

const ERC721_ABI = [
    // 基本的なERC721インターフェース
    'function balanceOf(address owner) view returns (uint256)',
    'function ownerOf(uint256 tokenId) view returns (address)',
    'function safeTransferFrom(address from, address to, uint256 tokenId)',
    'function transferFrom(address from, address to, uint256 tokenId)',
    'function approve(address to, uint256 tokenId)',
    'function getApproved(uint256 tokenId) view returns (address)',
    'function setApprovalForAll(address operator, bool approved)',
    'function isApprovedForAll(address owner, address operator) view returns (bool)',
    
    // オプショナルな機能
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function tokenURI(uint256 tokenId) view returns (string)',
    
    // Enumerable拡張
    'function totalSupply() view returns (uint256)',
    'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
    'function tokenByIndex(uint256 index) view returns (uint256)',
    
    // イベント
    'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
    'event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId)',
    'event ApprovalForAll(address indexed owner, address indexed operator, bool approved)'
];

// 状態管理
const state = {
    connected: false,
    transfers: [],
    processing: false,
    provider: null,
    signer: null,
    contract: null,
    selectedChainId: null,
    successCount: 0,
    failCount: 0,
    ownedNFTs: [],
    manualTransfers: []
};

// DOM要素の取得
const elements = {
    connectWallet: document.getElementById('connectWallet'),
    contractAddress: document.getElementById('contractAddress'),
    dropZone: document.getElementById('dropZone'),
    fileInput: document.getElementById('fileInput'),
    startTransfer: document.getElementById('startTransfer'),
    status: document.getElementById('status'),
    results: document.getElementById('results'),
    progressBar: document.getElementById('progressBar'),
    transferProgress: document.getElementById('transferProgress'),
    currentTask: document.getElementById('currentTask'),
    progressCount: document.getElementById('progressCount'),
    successCount: document.getElementById('successCount'),
    failCount: document.getElementById('failCount'),
    transferHistory: document.getElementById('transferHistory'),
    clearHistory: document.getElementById('clearHistory'),
    networkButtons: document.querySelectorAll('.network-button'),
    // 新しい要素の参照を追加
    nftSelect: document.getElementById('nftSelect'),
    manualAddress: document.getElementById('manualAddress'),
    manualTransfersList: document.getElementById('manualTransfersList'),
    manualTransferSection: document.getElementById('manualTransferSection'),
    addTransferButton: document.getElementById('addTransferButton')
};

// ネットワーク切り替え
async function switchNetwork(chainId) {
    try {
        if (!window.ethereum) throw new Error('MetaMaskがインストールされていません');

        const chainIdHex = `0x${Number(chainId).toString(16)}`;
        
        try {
            await window.ethereum.request({
                method: 'wallet_switchEthereumChain',
                params: [{ chainId: chainIdHex }],
            });
        } catch (switchError) {
            // チェーンが存在しない場合は追加を試みる
            if (switchError.code === 4902) {
                const network = NETWORKS[chainId];
                await window.ethereum.request({
                    method: 'wallet_addEthereumChain',
                    params: [
                        {
                            chainId: chainIdHex,
                            chainName: network.name,
                            rpcUrls: [network.rpcUrl],
                            nativeCurrency: {
                                name: network.symbol,
                                symbol: network.symbol,
                                decimals: 18
                            }
                        }
                    ]
                });
            } else {
                throw switchError;
            }
        }

        state.selectedChainId = chainId;
        updateNetworkButtons();
        showStatus(`${NETWORKS[chainId].name}ネットワークに切り替えました`, 'success');
    } catch (error) {
        showStatus('ネットワーク切り替えエラー: ' + error.message, 'error');
    }
}

// ウォレット接続
async function connectWallet() {
    try {
        if (!window.ethereum) {
            throw new Error('MetaMaskがインストールされていません');
        }

        state.provider = new ethers.providers.Web3Provider(window.ethereum);
        await state.provider.send('eth_requestAccounts', []);
        state.signer = state.provider.getSigner();
        
        const address = await state.signer.getAddress();
        elements.connectWallet.textContent = `接続済み: ${address.slice(0, 6)}...${address.slice(-4)}`;
        elements.connectWallet.disabled = true;
        state.connected = true;
        
        // 現在のネットワークを取得して表示を更新
        const network = await state.provider.getNetwork();
        state.selectedChainId = network.chainId;
        updateNetworkButtons();
        
        updateStartButton();
        showStatus('ウォレットが接続されました', 'success');
    } catch (error) {
        showStatus('ウォレット接続エラー: ' + error.message, 'error');
    }
}

// ファイル処理
async function handleFile(file) {
    try {
        const text = await file.text();
        const lines = text.split('\n');
        state.transfers = lines
            .map(line => {
                const [tokenId, toAddress] = line.trim().split(',');
                return tokenId && toAddress && ethers.utils.isAddress(toAddress)
                    ? { tokenId, toAddress }
                    : null;
            })
            .filter(transfer => transfer !== null);

        showStatus(`${state.transfers.length}件の転送データを読み込みました`, 'success');
        updateStartButton();
    } catch (error) {
        showStatus('ファイル読み込みエラー: ' + error.message, 'error');
    }
}

// NFTコレクション取得機能
async function fetchNFTCollection() {
    if (!state.contract) throw new Error('コントラクトが設定されていません');
    
    try {
        if (!elements.nftSelect) {
            throw new Error('必要なDOM要素が見つかりません');
        }

        elements.nftSelect.innerHTML = '<option value="">読み込み中...</option>';
        const ownerAddress = await state.signer.getAddress();
        const balance = await state.contract.balanceOf(ownerAddress);
        state.ownedNFTs = [];

        let foundTokens = false;
        
        // 方法1: EnumerableERC721を試す
        try {
            for (let i = 0; i < balance.toNumber(); i++) {
                const tokenId = await state.contract.tokenOfOwnerByIndex(ownerAddress, i);
                state.ownedNFTs.push(tokenId.toString());
            }
            foundTokens = true;
        } catch (error) {
            console.log('Enumerable extension not supported, trying alternate method');
        }
        
        // 方法2: イベントログから所有トークンを探す
        if (!foundTokens) {
            const filter = state.contract.filters.Transfer(null, ownerAddress);
            const events = await state.contract.queryFilter(filter);
            const potentialTokenIds = new Set(events.map(e => e.args.tokenId.toString()));
            
            // 現在の所有権を確認
            for (const tokenId of potentialTokenIds) {
                try {
                    const currentOwner = await state.contract.ownerOf(tokenId);
                    if (currentOwner.toLowerCase() === ownerAddress.toLowerCase()) {
                        state.ownedNFTs.push(tokenId);
                    }
                } catch (error) {
                    console.log(`Token ${tokenId} ownership check failed:`, error);
                }
            }
            foundTokens = state.ownedNFTs.length > 0;
        }
        
        if (!foundTokens) {
            throw new Error('NFTの検出に失敗しました');
        }
        
        updateNFTSelect();
        showStatus(`${state.ownedNFTs.length}個のNFTが見つかりました`, 'success');
    } catch (error) {
        console.error('NFT fetch error:', error);
        throw error;
    }
}

// NFTセレクトボックスの更新
function updateNFTSelect() {
    elements.nftSelect.innerHTML = `
        <option value="">NFTを選択してください</option>
        ${state.ownedNFTs.map(id => `
            <option value="${id}">TokenID: ${id}</option>
        `).join('')}
    `;
}

// 手動転送の追加
function addManualTransfer() {
    const tokenId = elements.nftSelect.value;
    const toAddress = elements.manualAddress.value;

    if (!tokenId || !toAddress) {
        showStatus('NFTとアドレスを入力してください', 'error');
        return;
    }

    if (!ethers.utils.isAddress(toAddress)) {
        showStatus('無効なアドレスです', 'error');
        return;
    }

    state.manualTransfers.push({ tokenId, toAddress });
    updateManualTransfersList();
    elements.nftSelect.value = '';
    elements.manualAddress.value = '';
}

// 手動転送リストの更新
function updateManualTransfersList() {
    elements.manualTransfersList.innerHTML = state.manualTransfers.map((transfer, index) => `
        <div class="manual-transfer-item">
            <span>TokenID: ${transfer.tokenId} → ${transfer.toAddress.slice(0, 6)}...${transfer.toAddress.slice(-4)}</span>
            <button onclick="removeManualTransfer(${index})" class="button button-small button-secondary">削除</button>
        </div>
    `).join('');
    
    updateStartButton();
}

// 手動転送の削除
function removeManualTransfer(index) {
    state.manualTransfers.splice(index, 1);
    updateManualTransfersList();
}

// コントラクトの設定時に呼び出す
async function setContract() {
    const contractAddress = elements.contractAddress.value;
    if (!contractAddress || !ethers.utils.isAddress(contractAddress)) {
        showStatus('無効なコントラクトアドレスです', 'error');
        return;
    }

    try {
        showStatus('コントラクトを確認中...', 'info');
        
        // まずコントラクトのインスタンスを作成
        state.contract = new ethers.Contract(contractAddress, ERC721_ABI, state.signer);
        const ownerAddress = await state.signer.getAddress();
        
        // 段階的に機能をチェック
        let contractInfo = '';
        
        // 1. 基本的なERC721機能をチェック
        try {
            await state.contract.balanceOf(ownerAddress);
            contractInfo += 'ERC721基本機能: OK\n';
        } catch (error) {
            console.error('Basic ERC721 check failed:', error);
            throw new Error('基本的なERC721機能が実装されていません');
        }
        
        // 2. メタデータ機能をチェック（オプショナル）
        try {
            const name = await state.contract.name();
            const symbol = await state.contract.symbol();
            contractInfo += `名前: ${name}, シンボル: ${symbol}\n`;
        } catch (error) {
            console.log('Metadata functions not found:', error);
            contractInfo += 'メタデータ機能: 利用不可（問題ありません）\n';
        }
        
        // 3. 所有者の残高を確認
        try {
            const balance = await state.contract.balanceOf(ownerAddress);
            contractInfo += `保有数: ${balance.toString()}\n`;
            
            if (balance.eq(0)) {
                throw new Error('このコントラクトのNFTを所持していません');
            }
        } catch (error) {
            console.error('Balance check failed:', error);
            throw error;
        }
        
        // 4. 具体的なトークンIDの取得を試みる
        try {
            await fetchNFTCollection();
            elements.manualTransferSection.style.display = 'block';
            showStatus('コントラクトの設定が完了しました\n' + contractInfo, 'success');
        } catch (error) {
            console.error('NFT fetch failed:', error);
            throw new Error('NFTの情報取得に失敗しました: ' + error.message);
        }
        
    } catch (error) {
        console.error('Contract setup error:', error);
        showStatus('コントラクト設定エラー: ' + error.message, 'error');
        state.contract = null;
    }
}

// NFT転送処理（続き）
// processTransfers関数の修正
async function processTransfers() {
    if (!state.connected || !state.contract) {
        showStatus('ウォレットとコントラクトの接続を確認してください', 'error');
        return;
    }

    // CSVと手動転送を結合
    const allTransfers = [...state.transfers, ...state.manualTransfers];
    if (allTransfers.length === 0) {
        showStatus('転送するNFTがありません', 'error');
        return;
    }

    state.processing = true;
    elements.startTransfer.disabled = true;
    elements.transferProgress.style.display = 'block';
    state.successCount = 0;
    state.failCount = 0;

    try {
        // アドレスの取得を最初に行う
        const signer = state.signer;
        const userAddress = await signer.getAddress();

        // 承認ステップの開始
        updateStep('stepApproval', 'active');
        showStatus('NFTの承認状態を確認中...', 'info');

        // 承認状態の確認
        const isApproved = await state.contract.isApprovedForAll(userAddress, userAddress);
        if (!isApproved) {
            try {
                showStatus('NFTの一括承認処理を開始します。MetaMaskでの承認が必要です...', 'info');
                const approveTx = await state.contract.setApprovalForAll(userAddress, true);
                showStatus('承認トランザクションの確認を待っています...', 'info');
                await approveTx.wait();
                showStatus('NFTの一括承認が完了しました', 'success');
                updateStep('stepApproval', 'completed');
            } catch (error) {
                if (error.code === 4001) {
                    throw new Error('承認がキャンセルされました');
                }
                throw new Error('承認処理に失敗しました: ' + error.message);
            }
        } else {
            updateStep('stepApproval', 'completed');
            showStatus('既に承認されています', 'success');
        }

        // 転送ステップの開始
        updateStep('stepTransfer', 'active');
        
        // バッチサイズの設定
        const BATCH_SIZE = 5;
        const results = [];

        for (let i = 0; i < allTransfers.length; i += BATCH_SIZE) {
            updateStep('stepTransfer', 'processing', `${i + 1}/${allTransfers.length}`);
            const batch = allTransfers.slice(i, i + BATCH_SIZE);
            const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
            const totalBatches = Math.ceil(allTransfers.length / BATCH_SIZE);
            
            showStatus(`バッチ ${batchNumber}/${totalBatches} の処理を開始します...`, 'info');
            elements.currentTask.textContent = `バッチ ${batchNumber}/${totalBatches} を処理中...`;

            // バッチ内の所有権を事前確認
            for (const transfer of batch) {
                const currentOwner = await state.contract.ownerOf(transfer.tokenId);
                if (currentOwner.toLowerCase() !== userAddress.toLowerCase()) {
                    throw new Error(`TokenID ${transfer.tokenId} の所有権がありません`);
                }
            }

            // バッチ転送の確認メッセージ
            const batchInfo = batch.map(t => `TokenID: ${t.tokenId}`).join(', ');
            showStatus(`${batch.length}個のNFTを転送します: ${batchInfo}\nMetaMaskでの承認が必要です...`, 'info');

            // 各トランザクションをPromiseの配列として準備
            const transferPromises = batch.map(transfer => {
                return state.contract.transferFrom(userAddress, transfer.toAddress, transfer.tokenId)
                    .then(async (tx) => {
                        const receipt = await tx.wait();
                        return {
                            transfer,
                            success: true,
                            txHash: receipt.transactionHash
                        };
                    })
                    .catch(error => {
                        console.error(`Error transferring TokenID ${transfer.tokenId}:`, error);
                        return {
                            transfer,
                            success: false,
                            error: error.code === 4001 ? 'キャンセルされました' : error.message
                        };
                    });
            });

            // バッチ内のすべての転送を並行処理
            const batchResults = await Promise.all(transferPromises);

            // 結果の処理
            for (const result of batchResults) {
                const processedResult = {
                    tokenId: result.transfer.tokenId,
                    toAddress: result.transfer.toAddress,
                    success: result.success,
                    ...(result.success ? { txHash: result.txHash } : { error: result.error }),
                    timestamp: new Date().toISOString()
                };

                results.push(processedResult);
                showResult(processedResult);
                
                if (result.success) {
                    state.successCount++;
                } else {
                    state.failCount++;
                }
            }

            updateProgressBar(((i + batch.length) / allTransfers.length) * 100);
            updateCounters();

            if (i + BATCH_SIZE < allTransfers.length) {
                showStatus('次のバッチの準備中...', 'info');
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        // 転送完了
        updateStep('stepTransfer', 'completed');

        // 履歴に保存
        saveToHistory({
            timestamp: new Date().toISOString(),
            contractAddress: state.contract.address,
            networkId: state.selectedChainId,
            totalCount: allTransfers.length,
            successCount: state.successCount,
            failCount: state.failCount,
            results: results
        });

        // 完了時のセレブレーション表示
        showCompletionCelebration(state.successCount, allTransfers.length);

    } catch (error) {
        console.error('Process transfers error:', error);
        showStatus('転送処理エラー: ' + error.message, 'error');
    } finally {
        state.processing = false;
        elements.startTransfer.disabled = false;
        elements.currentTask.textContent = '処理完了';
        updateProgressBar(100);
    }
}


// 履歴管理機能
function saveToHistory(historyItem) {
    const history = JSON.parse(localStorage.getItem('transferHistory') || '[]');
    history.unshift(historyItem);
    localStorage.setItem('transferHistory', JSON.stringify(history.slice(0, 50))); // 最新50件を保存
    updateHistoryDisplay();
}

function updateHistoryDisplay() {
    const history = JSON.parse(localStorage.getItem('transferHistory') || '[]');
    elements.transferHistory.innerHTML = '';
    
    history.forEach(item => {
        const div = document.createElement('div');
        div.className = 'history-item';
        div.innerHTML = `
            <div class="timestamp">${new Date(item.timestamp).toLocaleString()}</div>
            <div>コントラクト: ${item.contractAddress}</div>
            <div>ネットワーク: ${NETWORKS[item.networkId]?.name || 'Unknown'}</div>
            <div>結果: 成功 ${item.successCount} / 失敗 ${item.failCount} / 合計 ${item.totalCount}</div>
        `;
        elements.transferHistory.appendChild(div);
    });
}

// ユーティリティ関数
function updateProgressBar(percent) {
    elements.progressBar.style.width = `${percent}%`;
}

function updateCounters() {
    elements.successCount.textContent = `成功: ${state.successCount}`;
    elements.failCount.textContent = `失敗: ${state.failCount}`;
}

function updateNetworkButtons() {
    elements.networkButtons.forEach(button => {
        const chainId = parseInt(button.dataset.chainId);
        button.classList.toggle('active', chainId === state.selectedChainId);
    });
}

function updateStartButton() {
    elements.startTransfer.disabled = !state.connected || 
                                    !elements.contractAddress.value || 
                                    (state.transfers.length === 0 && state.manualTransfers.length === 0) ||
                                    state.processing;
}

function showStatus(message, type = 'info') {
    const statusElement = elements.status;
    if (!statusElement) {
        console.error('Status element not found');
        return;
    }
    
    statusElement.textContent = message;
    statusElement.className = `status ${type}`;
    statusElement.style.display = 'block';
    
    if (type !== 'error') {
        setTimeout(() => {
            statusElement.style.display = 'none';
        }, 5000);
    }
}

function showResult(result) {
    const div = document.createElement('div');
    div.className = `result-item ${result.success ? 'success' : 'error'}`;
    div.innerHTML = `
        <div class="result-header">
            <span class="result-token">TokenID: ${result.tokenId}</span>
            <span class="result-status ${result.success ? 'success' : 'error'}">
                ${result.success ? '✓ 成功' : '✗ 失敗'}
            </span>
        </div>
        <p class="result-address">送信先: ${result.toAddress}</p>
        ${result.success 
            ? `<p class="result-hash">TX: ${result.txHash.slice(0, 10)}...${result.txHash.slice(-8)}</p>`
            : `<p class="result-error">エラー: ${result.error}</p>`}
        <p class="result-timestamp">${new Date(result.timestamp).toLocaleString()}</p>
    `;
    elements.results.insertBefore(div, elements.results.firstChild);
}


// イベントリスナーの設定
document.addEventListener('DOMContentLoaded', () => {
    elements.connectWallet.addEventListener('click', connectWallet);
    elements.startTransfer.addEventListener('click', processTransfers);
    elements.contractAddress.addEventListener('input', updateStartButton);
    elements.clearHistory.addEventListener('click', () => {
        localStorage.removeItem('transferHistory');
        updateHistoryDisplay();
    });
    elements.addTransferButton.addEventListener('click', addManualTransfer);
    
    elements.networkButtons.forEach(button => {
        button.addEventListener('click', () => {
            const chainId = parseInt(button.dataset.chainId);
            switchNetwork(chainId);
        });
    });
    
    elements.dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        elements.dropZone.classList.add('dragover');
    });

    elements.dropZone.addEventListener('dragleave', () => {
        elements.dropZone.classList.remove('dragover');
    });

    elements.dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        elements.dropZone.classList.remove('dragover');
        const file = e.dataTransfer.files[0];
        if (file && file.type === 'text/csv') {
            handleFile(file);
        } else {
            showStatus('CSVファイルのみ対応しています', 'error');
        }
    });

    elements.dropZone.addEventListener('click', () => {
        elements.fileInput.click();
    });

    elements.fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            handleFile(file);
        }
    });

    // 履歴の初期表示
    updateHistoryDisplay();
});

// MetaMaskのチェーン変更イベントをリッスン
if (window.ethereum) {
    window.ethereum.on('chainChanged', (chainId) => {
        state.selectedChainId = parseInt(chainId, 16);
        updateNetworkButtons();
    });
    
    window.ethereum.on('accountsChanged', () => {
        // アカウントが変更されたら再接続が必要
        state.connected = false;
        elements.connectWallet.textContent = 'ウォレット接続';
        elements.connectWallet.disabled = false;
        updateStartButton();
    });
}

// ステップ管理とUI更新の関数
function updateStep(step, status, details = '') {
    const stepElement = document.getElementById(step);
    if (!stepElement) return;

    const steps = {
        stepApproval: 0,
        stepTransfer: 1
    };

    // MetaMask確認のプロンプト表示制御
    const metamaskPrompt = stepElement.querySelector('.metamask-prompt');
    if (metamaskPrompt) {
        metamaskPrompt.style.display = status === 'awaiting-confirmation' ? 'flex' : 'none';
    }

    // 処理詳細の表示制御
    const processingDetails = stepElement.querySelector('.processing-details');
    if (processingDetails) {
        processingDetails.style.display = status === 'processing' ? 'block' : 'none';
        if (details) {
            const processingCount = processingDetails.querySelector('.processing-count');
            if (processingCount) {
                processingCount.textContent = details;
            }
        }
    }

    // ステップのステータス更新
    Object.keys(steps).forEach(s => {
        const el = document.getElementById(s);
        if (steps[s] < steps[step]) {
            el.classList.add('completed');
            el.classList.remove('active');
        } else if (s === step) {
            el.classList.add('active');
            if (status === 'completed') {
                el.classList.add('completed');
            }
        } else {
            el.classList.remove('active', 'completed');
        }
    });
}

// 完了時のセレブレーション表示
function showCompletionCelebration(successCount, totalCount) {
    const celebration = document.getElementById('completionCelebration');
    document.getElementById('finalSuccessCount').textContent = successCount;
    document.getElementById('finalTotalCount').textContent = totalCount;
    celebration.style.display = 'flex';

    // コンフェッティアニメーション
    createConfetti();

    // 5秒後に自動で閉じる
    setTimeout(() => {
        celebration.style.display = 'none';
    }, 5000);
}

// コンフェッティアニメーションの作成
function createConfetti() {
    const colors = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff'];
    for (let i = 0; i < 100; i++) {
        const confetti = document.createElement('div');
        confetti.className = 'confetti';
        confetti.style.left = Math.random() * 100 + 'vw';
        confetti.style.background = colors[Math.floor(Math.random() * colors.length)];
        confetti.style.animation = `confetti-fall ${1 + Math.random() * 2}s linear`;
        document.getElementById('completionCelebration').appendChild(confetti);
        
        // アニメーション終了後に要素を削除
        confetti.addEventListener('animationend', () => confetti.remove());
    }
}