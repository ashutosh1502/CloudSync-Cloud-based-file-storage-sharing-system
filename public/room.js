// Firebase configuration
const firebaseConfig = {
    apiKey: "your-key",
    authDomain: "domain",
    projectId: "id",
    storageBucket: "s3-bucket",
    messagingSenderId: "sender-id",
    appId: "api-id"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();

// Initialize AWS S3
const s3 = new AWS.S3({
    region: "us-east-1",
    credentials: {
        accessKeyId: "your-access-key-id",
        secretAccessKey: "your-secret-access-key",
    },
    signatureVersion: 'v4',
    endpoint: 'https://s3.us-east-1.amazonaws.com',
    httpOptions: {
        timeout: 300000, // 5 minutes timeout
        xhrWithCredentials: true
    }
});

const bucketName = "cloud-sync-web-app";

// Get room ID from URL parameters
const urlParams = new URLSearchParams(window.location.search);
const roomId = urlParams.get('id');

// Current room data
let currentRoom = null;
let currentUser = null;
let userPermissions = null;

// Constants
const ROLE_PERMISSIONS = {
    owner: {
        canDelete: true,
        canEdit: true,
        canInvite: true,
        canRemoveMembers: true,
        canUpload: true,
        canDownload: true,
        canDeleteFiles: true,
        canManageRoles: true
    },
    admin: {
        canDelete: false,
        canEdit: true,
        canInvite: true,
        canRemoveMembers: true,
        canUpload: true,
        canDownload: true,
        canDeleteFiles: true,
        canManageRoles: false
    },
    member: {
        canDelete: false,
        canEdit: false,
        canInvite: false,
        canRemoveMembers: false,
        canUpload: true,
        canDownload: true,
        canDeleteFiles: false,
        canManageRoles: false
    },
    viewer: {
        canDelete: false,
        canEdit: false,
        canInvite: false,
        canRemoveMembers: false,
        canUpload: false,
        canDownload: true,
        canDeleteFiles: false,
        canManageRoles: false
    }
};

// Initialize room
async function initializeRoom() {
    try {
        // Show loading state
        document.body.innerHTML = `
            <div class="loading-overlay" style="display: flex;">
                <div style="text-align: center;">
                    <div class="loading-spinner"></div>
                    <p style="margin-top: 1rem; color: #666;">Loading room...</p>
                </div>
            </div>
        `;

        // Check authentication
        const user = await new Promise((resolve, reject) => {
            const unsubscribe = auth.onAuthStateChanged(user => {
                unsubscribe();
                if (user) resolve(user);
                else reject(new Error('Please sign in to access this room'));
            });
        });

        currentUser = user;

        if (!roomId) {
            throw new Error('Room ID not provided');
        }

        // Load room data with retry
        let retries = 3;
        let lastError;

        while (retries > 0) {
            try {
                currentRoom = await getRoomData();
                break;
            } catch (error) {
                lastError = error;
                retries--;
                if (retries > 0) {
                    await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second before retry
                }
            }
        }

        if (!currentRoom) {
            throw lastError || new Error('Failed to load room data');
        }

        // Check if user is a member (check both UID and email)
        const member = currentRoom.members.find(m =>
            m.id === user.uid || // Check by Firebase UID
            m.email === user.email || // Check by email
            (m.id && m.id.startsWith('pending_') && m.email === user.email) // Check pending invitations
        );

        if (!member) {
            throw new Error('Access denied: You are not a member of this room');
        }

        // If member was pending, update their data
        if (member.id && member.id.startsWith('pending_')) {
            member.id = user.uid;
            member.displayName = user.displayName || user.email.split('@')[0];
            member.joinedAt = new Date().toISOString();
            delete member.status;

            // Update room data
            await updateRoomData(currentRoom);

            // Update rooms index
            try {
                const response = await s3.getObject({
                    Bucket: bucketName,
                    Key: 'rooms/index.json'
                }).promise();
                let rooms = JSON.parse(response.Body.toString());
                const roomIndex = rooms.findIndex(r => r.id === roomId);
                if (roomIndex !== -1) {
                    rooms[roomIndex] = currentRoom;
                    await s3.putObject({
                        Bucket: bucketName,
                        Key: 'rooms/index.json',
                        Body: JSON.stringify(rooms),
                        ContentType: 'application/json'
                    }).promise();
                }
            } catch (error) {
                console.error('Error updating rooms index:', error);
            }

            // Log activity
            await logActivity({
                type: 'MEMBER_JOINED',
                memberEmail: user.email,
                memberId: user.uid,
                role: member.role,
                timestamp: new Date().toISOString()
            });
        }

        // Set user permissions
        userPermissions = ROLE_PERMISSIONS[member.role] || ROLE_PERMISSIONS.viewer;

        // Load the room HTML
        const response = await fetch('room-content.html');
        const html = await response.text();
        document.body.innerHTML = html;

        // Update UI
        updateRoomUI();
        await Promise.all([
            loadFiles(),
            loadMembers(),
            loadActivity()
        ]);
        setupEventListeners();

    } catch (error) {
        console.error('Error initializing room:', error);
        const errorMessage = error.message || 'An error occurred while loading the room';
        showToast(errorMessage, 'error');

        // Show error UI
        document.body.innerHTML = `
            <div style="text-align: center; padding: 2rem;">
                <h2 style="color: #dc3545; margin-bottom: 1rem;">Error</h2>
                <p style="color: #666; margin-bottom: 1rem;">${errorMessage}</p>
                <button onclick="window.location.href='home.html'" 
                        style="padding: 0.5rem 1rem; background: #007bff; color: white; 
                               border: none; border-radius: 4px; cursor: pointer;">
                    Return to Home
                </button>
            </div>
        `;
    }
}

// Get room data
async function getRoomData() {
    try {
        const response = await s3.getObject({
            Bucket: bucketName,
            Key: `rooms/${roomId}/metadata.json`
        }).promise();

        if (!response || !response.Body) {
            throw new Error('Room data not found');
        }

        try {
            const roomData = JSON.parse(response.Body.toString());
            if (!roomData || !roomData.members) {
                throw new Error('Invalid room data format');
            }
            return roomData;
        } catch (parseError) {
            console.error('Error parsing room data:', parseError);
            throw new Error('Invalid room data format');
        }
    } catch (error) {
        console.error('Error getting room data:', error);
        if (error.code === 'NoSuchKey') {
            throw new Error('Room not found');
        } else if (error.code === 'NetworkingError') {
            throw new Error('Network error: Please check your internet connection');
        } else if (error.code === 'AccessDenied') {
            throw new Error('Access denied: Please check your permissions');
        }
        throw error;
    }
}

// Update room UI
function updateRoomUI() {
    document.title = `${currentRoom.name} - CloudSync`;
    document.querySelector('.room-name').textContent = currentRoom.name;
    document.querySelector('.room-description').textContent = currentRoom.description || 'No description';
    document.querySelector('#memberCount').textContent = currentRoom.members.length;

    // Update UI based on permissions
    const uploadBtn = document.getElementById('uploadBtn');
    const settingsBtn = document.getElementById('settingsBtn');
    const inviteBtn = document.getElementById('inviteBtn');

    uploadBtn.style.display = userPermissions.canUpload ? 'block' : 'none';
    settingsBtn.style.display = userPermissions.canEdit ? 'block' : 'none';
    inviteBtn.style.display = userPermissions.canInvite ? 'block' : 'none';
}

// Load files
async function loadFiles() {
    const fileGrid = document.getElementById('fileGrid');
    fileGrid.innerHTML = '<div class="loading-overlay"><div class="loading-spinner"></div></div>';

    try {
        const response = await s3.listObjects({
            Bucket: bucketName,
            Prefix: `rooms/${roomId}/files/`
        }).promise();

        const files = response.Contents.filter(item => !item.Key.endsWith('/'));

        // Update stats
        document.getElementById('fileCount').textContent = files.length;
        const totalSize = files.reduce((acc, file) => acc + file.Size, 0);
        document.getElementById('totalSize').textContent = formatFileSize(totalSize);

        // Clear loading state
        fileGrid.innerHTML = '';

        if (files.length === 0) {
            fileGrid.innerHTML = '<p class="no-files">No files uploaded yet</p>';
            return;
        }

        // Sort files by last modified date
        files.sort((a, b) => b.LastModified - a.LastModified);

        files.forEach(file => {
            const fileItem = createFileElement(file);
            fileGrid.appendChild(fileItem);
        });

    } catch (error) {
        console.error('Error loading files:', error);
        showToast('Error loading files', 'error');
    }
}

// Create file element
function createFileElement(file) {
    const fileName = file.Key.split('/').pop();
    const fileExt = fileName.split('.').pop().toLowerCase();

    const fileItem = document.createElement('div');
    fileItem.className = 'file-item';

    const fileIcon = document.createElement('div');
    fileIcon.className = 'file-icon';
    fileIcon.textContent = getFileIcon(fileExt);

    const fileInfo = document.createElement('div');
    fileInfo.className = 'file-info';

    const nameElement = document.createElement('div');
    nameElement.className = 'file-name';
    nameElement.textContent = fileName;

    const detailsElement = document.createElement('div');
    detailsElement.className = 'file-details';
    detailsElement.textContent = `${formatFileSize(file.Size)} • ${formatDate(file.LastModified)}`;

    fileInfo.appendChild(nameElement);
    fileInfo.appendChild(detailsElement);

    // Add actions menu
    const actionsMenu = createFileActionsMenu(file);

    fileItem.appendChild(fileIcon);
    fileItem.appendChild(fileInfo);
    fileItem.appendChild(actionsMenu);

    return fileItem;
}

// Create file actions menu
function createFileActionsMenu(file) {
    const menu = document.createElement('div');
    menu.className = 'file-actions';

    const actions = [];

    // Download action (always available)
    actions.push({
        icon: '⬇️',
        label: 'Download',
        action: () => downloadFile(file)
    });

    // Delete action (if permitted)
    if (userPermissions.canDeleteFiles) {
        actions.push({
            icon: '🗑️',
            label: 'Delete',
            action: () => deleteFile(file)
        });
    }

    // Share action
    actions.push({
        icon: '🔗',
        label: 'Share',
        action: () => shareFile(file)
    });

    actions.forEach(action => {
        const button = document.createElement('button');
        button.className = 'btn btn-secondary btn-sm';
        button.innerHTML = `${action.icon} ${action.label}`;
        button.onclick = (e) => {
            e.stopPropagation();
            action.action();
        };
        menu.appendChild(button);
    });

    return menu;
}

// Load members
function loadMembers() {
    const memberList = document.getElementById('memberList');
    memberList.innerHTML = '';

    currentRoom.members.forEach(member => {
        const memberItem = document.createElement('div');
        memberItem.className = 'member-item';

        const avatar = document.createElement('div');
        avatar.className = 'member-avatar';
        avatar.textContent = member.email[0].toUpperCase();

        const info = document.createElement('div');
        info.className = 'member-info';

        const name = document.createElement('div');
        name.className = 'member-name';
        name.textContent = member.email;

        const role = document.createElement('div');
        role.className = 'member-role';
        role.textContent = member.role;

        info.appendChild(name);
        info.appendChild(role);

        memberItem.appendChild(avatar);
        memberItem.appendChild(info);

        // Add remove button if permitted
        if (userPermissions.canRemoveMembers && member.id !== currentUser.uid) {
            const removeBtn = document.createElement('button');
            removeBtn.className = 'btn btn-secondary btn-sm';
            removeBtn.textContent = '🗑️';
            removeBtn.onclick = () => removeMember(member);
            memberItem.appendChild(removeBtn);
        }

        memberList.appendChild(memberItem);
    });
}

// Load activity
async function loadActivity() {
    const activityList = document.getElementById('activityList');
    activityList.innerHTML = '<div class="loading-spinner"></div>';

    try {
        const response = await s3.getObject({
            Bucket: bucketName,
            Key: `rooms/${roomId}/activity_log.json`
        }).promise();

        const activities = JSON.parse(response.Body.toString());

        activityList.innerHTML = '';

        // Show last 10 activities
        activities.slice(0, 10).forEach(activity => {
            const activityItem = document.createElement('div');
            activityItem.className = 'activity-item';

            const icon = document.createElement('div');
            icon.className = 'activity-icon';
            icon.textContent = getActivityIcon(activity.type);

            const content = document.createElement('div');
            content.className = 'activity-content';
            content.innerHTML = `
                <div>${getActivityDescription(activity)}</div>
                <div class="activity-time">${formatDate(activity.timestamp)}</div>
            `;

            activityItem.appendChild(icon);
            activityItem.appendChild(content);
            activityList.appendChild(activityItem);
        });

    } catch (error) {
        if (error.code === 'NoSuchKey') {
            activityList.innerHTML = '<p>No activity yet</p>';
        } else {
            console.error('Error loading activity:', error);
            activityList.innerHTML = '<p>Error loading activity</p>';
        }
    }
}

// Setup event listeners
function setupEventListeners() {
    // Back button
    document.getElementById('backBtn').onclick = () => {
        window.location.href = 'home.html';
    };

    // Upload button
    const uploadBtn = document.getElementById('uploadBtn');
    const uploadOverlay = document.getElementById('uploadOverlay');
    const closeUploadBtn = document.getElementById('closeUploadBtn');
    const uploadDropzone = document.getElementById('uploadDropzone');
    const fileInput = document.getElementById('fileInput');

    uploadBtn.onclick = () => {
        uploadOverlay.classList.add('active');
    };

    closeUploadBtn.onclick = () => {
        uploadOverlay.classList.remove('active');
    };

    uploadDropzone.onclick = () => {
        fileInput.click();
    };

    // File upload handling
    fileInput.onchange = (e) => handleFileUpload(e.target.files);

    // Drag and drop handling
    uploadDropzone.ondragover = (e) => {
        e.preventDefault();
        uploadDropzone.classList.add('dragover');
    };

    uploadDropzone.ondragleave = () => {
        uploadDropzone.classList.remove('dragover');
    };

    uploadDropzone.ondrop = (e) => {
        e.preventDefault();
        uploadDropzone.classList.remove('dragover');
        handleFileUpload(e.dataTransfer.files);
    };

    // Settings button
    document.getElementById('settingsBtn').onclick = showSettings;

    // Invite button
    document.getElementById('inviteBtn').onclick = showInviteDialog;

    // Sort and filter buttons
    document.getElementById('sortBtn').onclick = showSortOptions;
    document.getElementById('filterBtn').onclick = showFilterOptions;
}

// File upload handling
async function handleFileUpload(files) {
    const uploadList = document.getElementById('uploadList');
    const uploadItems = [];
    const maxFileSize = 100 * 1024 * 1024; // 100MB limit

    // Create upload items
    for (const file of Array.from(files)) {
        // Validate file size
        if (file.size > maxFileSize) {
            showToast(`File ${file.name} is too large. Maximum size is 100MB.`, 'error');
            continue;
        }

        // Validate file type
        const allowedTypes = [
            'application/pdf',
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.ms-excel',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'text/plain',
            'image/jpeg',
            'image/png',
            'image/gif',
            'video/mp4',
            'audio/mpeg',
            'application/vnd.google-apps.document'  // For Google Docs
        ];

        if (!allowedTypes.includes(file.type)) {
            showToast(`File type ${file.type} is not supported.`, 'error');
            continue;
        }

        const item = document.createElement('div');
        item.className = 'upload-item';
        item.innerHTML = `
            <div class="upload-item-name">${file.name}</div>
            <div class="upload-item-status">Waiting...</div>
            <div class="progress-bar">
                <div class="progress-bar-fill"></div>
            </div>
        `;
        uploadList.appendChild(item);
        uploadItems.push({ file, element: item });
    }

    // Process uploads
    for (const item of uploadItems) {
        try {
            await uploadFile(item.file, item.element);
        } catch (error) {
            console.error('Error uploading file:', error);
            // Error handling is done in uploadFile function
        }
    }
}

// Upload single file
async function uploadFile(file, uploadElement) {
    const fileName = `rooms/${roomId}/files/${file.name}`;

    try {
        // First, try to get a pre-signed URL for the upload
        const presignedUrl = await s3.getSignedUrlPromise('putObject', {
            Bucket: bucketName,
            Key: fileName,
            ContentType: file.type,
            Expires: 3600, // URL expires in 1 hour
            ACL: 'private'
        });

        // Use fetch API to upload the file
        const response = await fetch(presignedUrl, {
            method: 'PUT',
            body: file,
            headers: {
                'Content-Type': file.type,
            },
            onUploadProgress: (progressEvent) => {
                const percent = Math.round((progressEvent.loaded / progressEvent.total) * 100);
                updateUploadProgress(uploadElement, percent);
            }
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        updateUploadStatus(uploadElement, 'Completed', 'success');

        // Log activity
        await logActivity({
            type: 'FILE_UPLOADED',
            fileName: file.name,
            fileSize: file.size,
            timestamp: new Date().toISOString(),
            performedBy: currentUser.email
        });

        // Refresh the file list
        await loadFiles();

    } catch (error) {
        console.error('Error uploading file:', error);

        // Show more specific error message
        let errorMessage = 'Failed to upload file. ';
        if (error.code === 'NetworkingError') {
            errorMessage += 'Please check your internet connection and try again.';
        } else if (error.code === 'AccessDenied') {
            errorMessage += 'Access denied. Please check your permissions.';
        } else if (error.code === 'RequestTimeout') {
            errorMessage += 'Upload timed out. Please try again.';
        } else {
            errorMessage += error.message || 'Unknown error occurred.';
        }

        updateUploadStatus(uploadElement, 'Failed: ' + errorMessage, 'error');
        showToast(errorMessage, 'error');
        throw error;
    }
}

// Update upload progress
function updateUploadProgress(element, percent) {
    const progressBar = element.querySelector('.progress-bar-fill');
    const status = element.querySelector('.upload-item-status');
    progressBar.style.width = `${percent}%`;
    status.textContent = `Uploading: ${percent}%`;
}

// Update upload status
function updateUploadStatus(element, status, type) {
    const statusElement = element.querySelector('.upload-item-status');
    statusElement.textContent = status;
    statusElement.className = `upload-item-status ${type}`;
}

// Download file
async function downloadFile(file) {
    try {
        const url = await s3.getSignedUrl('getObject', {
            Bucket: bucketName,
            Key: file.Key,
            Expires: 60,
            ResponseContentDisposition: `attachment; filename="${file.Key.split('/').pop()}"`
        });

        window.open(url, '_blank');

        // Log activity
        await logActivity({
            type: 'FILE_DOWNLOADED',
            fileName: file.Key.split('/').pop(),
            timestamp: new Date().toISOString(),
            performedBy: currentUser.email
        });

    } catch (error) {
        console.error('Error downloading file:', error);
        showToast('Error downloading file', 'error');
    }
}

// Delete file
async function deleteFile(file) {
    if (!confirm('Are you sure you want to delete this file?')) return;

    try {
        await s3.deleteObject({
            Bucket: bucketName,
            Key: file.Key
        }).promise();

        // Log activity
        await logActivity({
            type: 'FILE_DELETED',
            fileName: file.Key.split('/').pop(),
            timestamp: new Date().toISOString(),
            performedBy: currentUser.email
        });

        await loadFiles();
        showToast('File deleted successfully', 'success');

    } catch (error) {
        console.error('Error deleting file:', error);
        showToast('Error deleting file', 'error');
    }
}

// Share file
async function shareFile(file) {
    try {
        const url = await s3.getSignedUrl('getObject', {
            Bucket: bucketName,
            Key: file.Key,
            Expires: 7 * 24 * 60 * 60 // 7 days
        });

        await navigator.clipboard.writeText(url);
        showToast('Share link copied to clipboard (valid for 7 days)', 'success');

        // Log activity
        await logActivity({
            type: 'FILE_SHARED',
            fileName: file.Key.split('/').pop(),
            timestamp: new Date().toISOString(),
            performedBy: currentUser.email
        });

    } catch (error) {
        console.error('Error sharing file:', error);
        showToast('Error generating share link', 'error');
    }
}

// Remove member
async function removeMember(member) {
    if (!confirm(`Are you sure you want to remove ${member.email} from the room?`)) return;

    try {
        const updatedMembers = currentRoom.members.filter(m => m.id !== member.id);
        await updateRoomData({ ...currentRoom, members: updatedMembers });

        // Log activity
        await logActivity({
            type: 'MEMBER_REMOVED',
            memberEmail: member.email,
            timestamp: new Date().toISOString(),
            performedBy: currentUser.email
        });

        currentRoom.members = updatedMembers;
        loadMembers();
        showToast('Member removed successfully', 'success');

    } catch (error) {
        console.error('Error removing member:', error);
        showToast('Error removing member', 'error');
    }
}

// Update room data
async function updateRoomData(newData) {
    try {
        await s3.putObject({
            Bucket: bucketName,
            Key: `rooms/${roomId}/metadata.json`,
            Body: JSON.stringify(newData),
            ContentType: 'application/json'
        }).promise();
    } catch (error) {
        console.error('Error updating room data:', error);
        throw error;
    }
}

// Log activity
async function logActivity(activity) {
    try {
        const logKey = `rooms/${roomId}/activity_log.json`;
        let activities = [];

        try {
            const existing = await s3.getObject({
                Bucket: bucketName,
                Key: logKey
            }).promise();
            activities = JSON.parse(existing.Body.toString());
        } catch (error) {
            if (error.code !== 'NoSuchKey') throw error;
        }

        activities.unshift(activity);

        // Keep only last 100 activities
        if (activities.length > 100) {
            activities = activities.slice(0, 100);
        }

        await s3.putObject({
            Bucket: bucketName,
            Key: logKey,
            Body: JSON.stringify(activities),
            ContentType: 'application/json'
        }).promise();

        // Refresh activity list
        loadActivity();

    } catch (error) {
        console.error('Error logging activity:', error);
        throw error;
    }
}

// Show settings dialog
function showSettings() {
    // Implementation for room settings dialog
    // This would include room name, description, and other settings
    alert('Settings functionality coming soon!');
}

// Show invite dialog
function showInviteDialog() {
    const email = prompt('Enter email address to invite:');
    if (email) {
        inviteMember(email);
    }
}

// Invite member
async function inviteMember(email) {
    try {
        // Check if member already exists
        if (currentRoom.members.some(m => m.email === email)) {
            showToast('Member already exists in the room', 'error');
            return;
        }

        // Get user data
        const userData = await getUserByEmail(email);
        if (!userData) {
            showToast('User not found. Make sure they have logged in at least once.', 'error');
            return;
        }

        // Add member
        const newMember = {
            id: userData.id,
            email: userData.email,
            displayName: userData.displayName,
            role: 'member',
            invitedAt: new Date().toISOString(),
            invitedBy: currentUser.email
        };

        const updatedMembers = [...currentRoom.members, newMember];
        await updateRoomData({ ...currentRoom, members: updatedMembers });

        // Log activity
        await logActivity({
            type: 'MEMBER_INVITED',
            memberEmail: email,
            timestamp: new Date().toISOString(),
            performedBy: currentUser.email
        });

        currentRoom.members = updatedMembers;
        loadMembers();
        showToast('Member invited successfully', 'success');

    } catch (error) {
        console.error('Error inviting member:', error);
        showToast('Error inviting member', 'error');
    }
}

// Show sort options
function showSortOptions() {
    const options = ['Name', 'Date', 'Size'];
    const choice = prompt(`Sort by:\n${options.join('\n')}`);
    if (choice) {
        sortFiles(choice.toLowerCase());
    }
}

// Show filter options
function showFilterOptions() {
    const options = ['All', 'Documents', 'Images', 'Videos', 'Audio'];
    const choice = prompt(`Filter by:\n${options.join('\n')}`);
    if (choice) {
        filterFiles(choice.toLowerCase());
    }
}

// Sort files
function sortFiles(criteria) {
    const fileGrid = document.getElementById('fileGrid');
    const files = Array.from(fileGrid.children);

    files.sort((a, b) => {
        const aName = a.querySelector('.file-name').textContent;
        const bName = b.querySelector('.file-name').textContent;

        switch (criteria) {
            case 'name':
                return aName.localeCompare(bName);
            case 'date':
                return b.dataset.date - a.dataset.date;
            case 'size':
                return b.dataset.size - a.dataset.size;
            default:
                return 0;
        }
    });

    fileGrid.innerHTML = '';
    files.forEach(file => fileGrid.appendChild(file));
}

// Filter files
function filterFiles(type) {
    const fileGrid = document.getElementById('fileGrid');
    const files = Array.from(fileGrid.children);

    files.forEach(file => {
        const fileName = file.querySelector('.file-name').textContent.toLowerCase();
        const ext = fileName.split('.').pop();

        let show = type === 'all';
        if (!show) {
            switch (type) {
                case 'documents':
                    show = ['pdf', 'doc', 'docx', 'txt', 'xls', 'xlsx'].includes(ext);
                    break;
                case 'images':
                    show = ['jpg', 'jpeg', 'png', 'gif', 'bmp'].includes(ext);
                    break;
                case 'videos':
                    show = ['mp4', 'avi', 'mov', 'wmv'].includes(ext);
                    break;
                case 'audio':
                    show = ['mp3', 'wav', 'ogg'].includes(ext);
                    break;
            }
        }

        file.style.display = show ? 'block' : 'none';
    });
}

// Get user data by email
async function getUserByEmail(email) {
    try {
        // Get user from Firebase Auth
        const userRecord = await firebase.auth().fetchSignInMethodsForEmail(email);
        if (!userRecord || userRecord.length === 0) {
            return null;
        }

        // Get user data from S3 (for additional data like displayName)
        let userData = null;
        try {
            const response = await s3.getObject({
                Bucket: bucketName,
                Key: 'users/index.json'
            }).promise();
            const users = JSON.parse(response.Body.toString());
            userData = users[email];
        } catch (error) {
            if (error.code !== 'NoSuchKey') {
                console.error('Error getting user data from S3:', error);
            }
        }

        // Return combined data
        return {
            id: userData?.id || email, // Use email as fallback ID
            email: email,
            displayName: userData?.displayName || email.split('@')[0],
            lastLogin: userData?.lastLogin || new Date().toISOString()
        };
    } catch (error) {
        console.error('Error getting user data:', error);
        throw error;
    }
}

// Utility functions
function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatDate(date) {
    return new Date(date).toLocaleString();
}

function getFileIcon(extension) {
    switch (extension) {
        case 'pdf': return '📄';
        case 'doc':
        case 'docx': return '📝';
        case 'xls':
        case 'xlsx': return '📊';
        case 'jpg':
        case 'jpeg':
        case 'png':
        case 'gif': return '🖼️';
        case 'mp4':
        case 'avi':
        case 'mov': return '🎥';
        case 'mp3':
        case 'wav': return '🎵';
        default: return '📄';
    }
}

function getActivityIcon(type) {
    switch (type) {
        case 'FILE_UPLOADED': return '📤';
        case 'FILE_DOWNLOADED': return '📥';
        case 'FILE_DELETED': return '🗑️';
        case 'FILE_SHARED': return '🔗';
        case 'MEMBER_INVITED': return '👋';
        case 'MEMBER_REMOVED': return '🚫';
        case 'SETTINGS_UPDATED': return '⚙️';
        default: return '📝';
    }
}

function getActivityDescription(activity) {
    switch (activity.type) {
        case 'FILE_UPLOADED':
            return `${activity.performedBy} uploaded ${activity.fileName}`;
        case 'FILE_DOWNLOADED':
            return `${activity.performedBy} downloaded ${activity.fileName}`;
        case 'FILE_DELETED':
            return `${activity.performedBy} deleted ${activity.fileName}`;
        case 'FILE_SHARED':
            return `${activity.performedBy} shared ${activity.fileName}`;
        case 'MEMBER_INVITED':
            return `${activity.performedBy} invited ${activity.memberEmail}`;
        case 'MEMBER_REMOVED':
            return `${activity.performedBy} removed ${activity.memberEmail}`;
        case 'SETTINGS_UPDATED':
            return `${activity.performedBy} updated room settings`;
        default:
            return 'Unknown activity';
    }
}

function showToast(message, type = 'success') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// Initialize room when page loads
initializeRoom();
